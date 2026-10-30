import { mkdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Core, dimensions } from './service.js';
import { id, now } from './store.js';
import { transition } from './state.js';
import { atomicWrite, inspectStored, inside, hash } from './files.js';
import { composeImage, normalizeImage } from '../composer/index.js';
import { inspectImage, OpenAIVisionReviewer, type VisionReviewer, type QAReport } from '../quality/index.js';
import { validatePlan } from '../planner/index.js';
import {
  ProviderError,
  validateProviderResult,
  providerConfiguration,
  type ProviderResult,
} from '../providers/index.js';

type VisionFactory = (config: Record<string, any>) => VisionReviewer;
const defaultVisionFactory: VisionFactory = (config) =>
  new OpenAIVisionReviewer({
    model: config.model,
    authorized: true,
    reservationUsd: config.reservation_usd,
    inputUsdPerMillion: config.input_usd_per_million,
    outputUsdPerMillion: config.output_usd_per_million,
  });
async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export class Worker {
  readonly workerId = id('worker');
  private timer?: ReturnType<typeof setInterval>;
  private active = new Set<Promise<void>>();
  private stopped = false;
  constructor(
    readonly core: Core,
    readonly concurrency = 2,
    readonly leaseMs = 30000,
    private readonly visionFactory: VisionFactory = defaultVisionFactory,
  ) {}
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 300);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.active]);
  }
  async tick() {
    if (this.stopped) return;
    await this.recover();
    while (this.active.size < this.concurrency) {
      const task = this.claim();
      if (!task) break;
      const promise = this.execute(task)
        .catch(() => {
          /* Durable lease recovery handles transient storage failure. */
        })
        .finally(() => this.active.delete(promise));
      this.active.add(promise);
    }
  }
  async drain(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.tick();
      await Promise.allSettled([...this.active]);
      const pending = this.core.store
        .tasks()
        .some(
          (t) =>
            ['queued', 'running', 'qa_pending'].includes(t.status) &&
            !['paused', 'cancelled'].includes(this.core.require('batch', t.batch_id).status),
        );
      if (!pending) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Worker drain timed out');
  }
  claim() {
    return this.core.store.transaction(() => {
      for (const task of this.core.store.tasks()) {
        if (task.status !== 'queued' || task.next_run > Date.now()) continue;
        const batch = this.core.require('batch', task.batch_id);
        if (['paused', 'cancelled'].includes(batch.status)) continue;
        if (task.dependency_task_id) {
          const base = this.core.require('task', task.dependency_task_id);
          if (['failed', 'blocked', 'cancelled', 'reconciling'].includes(base.status)) {
            this.core.store.saveTask(transition(task, 'blocked'));
            this.core.updateBatch(batch.id);
            continue;
          }
          if (!base.asset_id) continue;
          task.parent_asset_id = base.asset_id;
        }
        const provider = this.core.providers.get(task.provider)!;
        const running = this.core.store
          .tasks()
          .filter((t) => t.provider === task.provider && ['running', 'qa_pending'].includes(t.status)).length;
        if (running >= provider.capabilities().maxConcurrency) continue;
        if (batch.cost_usd + batch.reserved_usd + task.estimated_cost_usd > batch.budget_usd + 1e-9) {
          this.core.store.saveTask({
            ...transition(task, 'blocked'),
            error: { code: 'BUDGET_EXCEEDED', message: 'Budget exhausted' },
          });
          this.core.updateBatch(batch.id);
          continue;
        }
        batch.reserved_usd += task.estimated_cost_usd;
        this.core.store.put('batch', batch);
        const attemptId = id('attempt'),
          current = {
            ...transition(task, 'running'),
            lease_owner: this.workerId,
            lease_until: Date.now() + this.leaseMs,
            attempt_count: task.attempt_count + 1,
            attempt_id: attemptId,
          };
        this.core.store.saveTask(current);
        this.core.store.put('attempt', {
          id: attemptId,
          project_id: current.project_id,
          task_id: current.id,
          provider: current.provider,
          status: 'started',
          estimated_cost_usd: current.estimated_cost_usd,
          created_at: now(),
        });
        this.core.store.event('task.running', current.id);
        this.core.updateBatch(batch.id);
        return current;
      }
      return undefined;
    });
  }
  owns(task: any) {
    const current = this.core.store.task(task.id);
    return current?.attempt_id === task.attempt_id && current?.lease_owner === this.workerId;
  }
  private heartbeat(task: any) {
    const timer = setInterval(
      () => {
        try {
          if (this.owns(task)) {
            const current = this.core.require('task', task.id);
            this.core.store.saveTask({ ...current, lease_until: Date.now() + this.leaseMs });
          }
        } catch {
          /* A transient database lock must not crash the worker process. */
        }
      },
      Math.max(10, Math.floor(this.leaseMs / 3)),
    );
    timer.unref();
    return timer;
  }
  async execute(task: any) {
    const { core } = this,
      plan = core.require('plan', task.plan_id),
      heartbeat = this.heartbeat(task);
    let received = false;
    try {
      const outputDir = join(core.root, 'attempts', task.attempt_id);
      await mkdir(outputDir, { recursive: true });
      validatePlan(plan, core.context(plan.project_id, plan.product.truth_snapshot_id));
      const batchConfig = core.require('batch', task.batch_id),
        providerSnapshot = providerConfiguration(core.providers.get(task.provider)!);
      if (
        (batchConfig.provider_config_hash &&
          hash(JSON.stringify(providerSnapshot)) !== batchConfig.provider_config_hash) ||
        (!batchConfig.provider_config_hash &&
          core.providers.get(task.provider)!.capabilities().paid &&
          ['generate', 'edit'].includes(plan.strategy))
      )
        throw new ProviderError(
          'PROVIDER_CONFIGURATION_CHANGED',
          'Provider configuration changed or its approved snapshot is missing; create a new plan and budget before external execution.',
        );

      const size = dimensions(plan.aspect_ratio),
        references = plan.reference_asset_ids.map((assetId: string) => core.require('asset', assetId));
      const checked = [...references];
      if (plan.product.truth_snapshot_id) {
        const truth = core.require('truth', plan.product.truth_snapshot_id);
        for (const fact of truth.facts) checked.push(core.require('asset', fact.source_asset_id));
      }
      if (plan.background_asset_id) checked.push(core.require('asset', plan.background_asset_id));
      if (plan.authorized_logo_asset_id) checked.push(core.require('asset', plan.authorized_logo_asset_id));
      if (task.parent_asset_id) checked.push(core.require('asset', task.parent_asset_id));
      for (const asset of checked) {
        await inside(core.root, asset.path);
        if (hash(await readFile(asset.path)) !== asset.sha256)
          throw Object.assign(new Error('Source asset hash changed'), { code: 'ASSET_TAMPERED' });
      }
      let result: ProviderResult;
      if (['reuse', 'compose'].includes(plan.strategy)) {
        const needsCutout =
          Boolean(plan.background_asset_id) ||
          (plan.fidelity === 'controlled' && plan.allowed_changes.includes('color'));
        const source =
          references.find(
            (asset: any) =>
              ['product_photo', 'cutout'].includes(asset.kind) &&
              asset.verified &&
              asset.authorized &&
              (!needsCutout || asset.kind === 'cutout'),
          ) ??
          (plan.fidelity === 'strict' || needsCutout
            ? undefined
            : references.find((asset: any) => !['logo', 'document'].includes(asset.kind)));
        if (!source) throw new Error('A verified image source is required');
        const path = join(outputDir, 'composed.png'),
          logo = plan.authorized_logo_asset_id
            ? core.require('asset', plan.authorized_logo_asset_id)
            : undefined;
        const backgrounds = ['#eeece6', '#e4ece6', '#e9e4dd', '#dce6eb'];
        if (plan.strategy === 'reuse' && plan.fidelity === 'strict' && !task.revision_controls)
          await normalizeImage(source.path, path, size.width, size.height);
        else
          await composeImage({
            sourcePath: source.path,
            outputPath: path,
            ...size,
            background: task.revision_controls?.background ?? backgrounds[task.variant % backgrounds.length],
            logoPath: logo?.path,
            concept: plan.fidelity !== 'strict',
            label: plan.claims?.map((claim: any) => `${claim.name}: ${claim.value}`).join(' · ') || undefined,
            backgroundPath:
              !task.revision_controls?.background && plan.background_asset_id
                ? core.require('asset', plan.background_asset_id).path
                : undefined,
            variant: task.variant,
            color:
              task.revision_controls?.color ??
              (plan.fidelity === 'controlled' && plan.allowed_changes.includes('color')
                ? ['#9e372e', '#315e4e', '#375679'][task.variant % 3]
                : undefined),
          });
        result = { path, provider: 'deterministic', model: 'sharp', costUsd: 0, mock: false };
      } else {
        const provider = core.providers.get(task.provider)!,
          controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          Number(process.env.CREATIVE_PROVIDER_TIMEOUT_MS ?? 120000),
        );
        try {
          const referencePaths = references
            .filter((asset: any) => asset.kind !== 'document')
            .map((asset: any) => asset.path);
          if (task.parent_asset_id) referencePaths.unshift(core.require('asset', task.parent_asset_id).path);
          const request = {
            taskId: task.id,
            attemptId: task.attempt_id,
            prompt: task.prompt.text,
            outputDir,
            ...size,
            referencePaths,
            signal: controller.signal,
          };
          const editing = plan.strategy === 'edit' || Boolean(task.parent_asset_id);
          if (editing && !provider.capabilities().edit)
            throw new ProviderError(
              'UNSUPPORTED_CAPABILITY',
              'This provider cannot edit a base or revision image.',
            );
          result = await (editing ? provider.edit(request) : provider.generate(request));
        } finally {
          clearTimeout(timeout);
        }
      }
      validateProviderResult(result);
      await inside(outputDir, result.path);
      await inspectStored(core.root, result.path);
      await atomicWrite(join(outputDir, 'receipt.json'), JSON.stringify(result));
      received = true;
      if (this.owns(task)) await this.finish(task, result);
    } catch (error) {
      if (this.owns(task)) this.fail(task, error, received);
    } finally {
      clearInterval(heartbeat);
    }
  }
  async finish(task: any, result: ProviderResult) {
    if (!this.owns(task)) return;
    const heartbeat = this.heartbeat(task);
    try {
      await this.finishOwned(task, result);
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async finishOwned(task: any, result: ProviderResult) {
    validateProviderResult(result);
    const { core } = this;
    if (!this.owns(task)) return;
    const plan = core.require('plan', task.plan_id),
      size = dimensions(plan.aspect_ratio),
      identity = result.mock ? 'mock' : plan.fidelity === 'strict' ? 'real_product' : 'concept';
    const prior = core.store
      .list('asset', task.project_id)
      .find((asset) => asset.attempt_id === task.attempt_id);
    if (prior) return;
    core.store.transaction(() => {
      if (this.owns(task)) core.store.saveTask(transition(core.require('task', task.id), 'qa_pending'));
    });
    const outputDir = join(core.root, 'attempts', task.attempt_id);
    await mkdir(outputDir, { recursive: true });
    const preparedPath = join(outputDir, 'prepared.json'),
      qaPath = join(outputDir, 'qa-receipt.json'),
      startedPath = join(outputDir, 'qa-started.json');
    let prepared: { assetId: string; path: string; metadata: any };
    if (await exists(preparedPath)) {
      prepared = JSON.parse(await readFile(preparedPath, 'utf8'));
      const metadata = await inspectStored(core.root, prepared.path);
      if (metadata.sha256 !== prepared.metadata.sha256)
        throw new ProviderError('ASSET_TAMPERED', 'Prepared result hash changed.', { uncertain: true });
    } else {
      const assetId = id('asset'),
        path = join(core.root, 'assets', `${assetId}.png`);
      await mkdir(join(core.root, 'assets'), { recursive: true });
      if (identity === 'concept' || identity === 'mock')
        await composeImage({
          sourcePath: result.path,
          outputPath: path,
          ...size,
          concept: true,
          label: identity === 'mock' ? 'MOCK — NOT PRODUCTION' : 'CONCEPT / FOR REVIEW',
        });
      else await normalizeImage(result.path, path, size.width, size.height);
      prepared = { assetId, path, metadata: await inspectStored(core.root, path) };
      await atomicWrite(preparedPath, JSON.stringify(prepared));
    }
    const { assetId, path, metadata } = prepared;
    let qaRecord: any;
    if (await exists(qaPath)) {
      qaRecord = JSON.parse(await readFile(qaPath, 'utf8'));
      if (qaRecord.asset_id !== assetId)
        throw new ProviderError('QA_RECEIPT_MISMATCH', 'QA receipt references a different prepared image.', {
          uncertain: true,
        });
    } else {
      if (!this.owns(task)) return;
      const batch = core.require('batch', task.batch_id),
        current = core.require('task', task.id);
      const options = {
        ...size,
        identity,
        deliveryRule: plan.delivery_rule_snapshot,
        fidelity: plan.fidelity,
        prompt: task.prompt.text,
        conceptLabelApplied: identity === 'concept' || identity === 'mock',
        referencePaths: plan.reference_asset_ids
          .map((assetId: string) => core.require('asset', assetId))
          .filter((asset: any) => asset.kind !== 'document')
          .map((asset: any) => asset.path),
      };
      let qa: QAReport;
      if (await exists(startedPath)) {
        // A charged semantic review may have completed before the process died. Never repeat it automatically.
        qa = await inspectImage(path, options);
        qa.status = 'block';
        qa.vision = {
          status: 'failed',
          reason:
            'A previous vision call has no durable result; operator reconciliation is required. No second call was made.',
          cost_usd: batch.vision_config?.reservation_usd ?? 0,
          cost_basis: 'reservation_estimate',
        };
        qa.issues.push({
          category: 'vision_outcome_unknown',
          severity: 'block',
          description: qa.vision.reason!,
        });
      } else if (batch.vision_review && !current.cancel_requested && batch.status !== 'cancelled') {
        if (!batch.authorize_paid || !batch.vision_config)
          throw new ProviderError(
            'PAID_AUTHORIZATION_REQUIRED',
            'Vision review lacks an authorized configuration.',
          );
        const reviewer = this.visionFactory(batch.vision_config);
        if (reviewer.estimateCost && reviewer.estimateCost() > batch.vision_config.reservation_usd + 1e-9)
          throw new ProviderError(
            'VISION_BUDGET_MISMATCH',
            'Vision reviewer estimate exceeds the batch reservation.',
          );
        await atomicWrite(
          startedPath,
          JSON.stringify({
            task_id: task.id,
            attempt_id: task.attempt_id,
            model: batch.vision_config.model,
            reservation_usd: batch.vision_config.reservation_usd,
            started_at: now(),
          }),
        );
        qa = await inspectImage(path, { ...options, visionRequired: true, visionReviewer: reviewer });
      } else {
        qa = await inspectImage(path, options);
        if (batch.vision_review)
          qa.vision = {
            status: 'skipped',
            reason: 'Batch was cancelled before paid semantic review.',
            cost_usd: 0,
            cost_basis: 'not_requested',
          };
      }
      qaRecord = { ...qa, id: id('qa'), project_id: task.project_id, asset_id: assetId, created_at: now() };
      await atomicWrite(qaPath, JSON.stringify(qaRecord));
    }
    core.store.transaction(() => {
      if (!this.owns(task)) return;
      const current = core.require('task', task.id),
        batch = core.require('batch', task.batch_id);
      const visionCost = Number(qaRecord.vision?.cost_usd ?? 0),
        totalCost = result.costUsd + visionCost;
      batch.reserved_usd = Math.max(0, batch.reserved_usd - task.estimated_cost_usd);
      batch.cost_usd += totalCost;
      core.store.put('batch', batch);
      core.store.put('attempt', {
        ...core.require('attempt', task.attempt_id),
        status: qaRecord.vision?.status === 'failed' ? 'review_uncertain' : 'succeeded',
        result: { ...result, path: undefined },
        image_cost_usd: result.costUsd,
        vision_cost_usd: visionCost,
        vision_cost_basis: qaRecord.vision?.cost_basis,
        cost_usd: totalCost,
        finished_at: now(),
      });
      core.store.put('qa', qaRecord);
      core.store.put('asset', {
        id: assetId,
        project_id: task.project_id,
        batch_id: task.batch_id,
        task_id: task.id,
        attempt_id: task.attempt_id,
        path,
        filename: `${assetId}.png`,
        ...metadata,
        identity,
        review_status: 'pending',
        parent_asset_id: task.parent_asset_id,
        reference_asset_ids: [
          ...new Set([
            ...plan.reference_asset_ids,
            ...(plan.background_asset_id ? [plan.background_asset_id] : []),
            ...(plan.authorized_logo_asset_id ? [plan.authorized_logo_asset_id] : []),
          ]),
        ],
        truth_snapshot_id: plan.product.truth_snapshot_id,
        skill_version: plan.skill_version,
        prompt: task.prompt,
        provider: result.provider,
        model: result.model,
        qa_id: qaRecord.id,
        allowed_uses: [plan.delivery_target],
        created_at: now(),
      });
      const updated = transition(
        current,
        current.cancel_requested || batch.status === 'cancelled'
          ? 'cancelled'
          : qaRecord.status === 'block'
            ? 'blocked'
            : 'review_pending',
      );
      core.store.saveTask({
        ...updated,
        asset_id: assetId,
        cost_usd: totalCost,
        lease_owner: null,
        lease_until: null,
        retry_safe: false,
        error:
          qaRecord.vision?.status === 'failed'
            ? { code: 'VISION_RECONCILIATION_REQUIRED', message: qaRecord.vision.reason }
            : undefined,
      });
      core.updateBatch(batch.id);
      core.store.event('task.finished', task.id, { asset_id: assetId, status: updated.status });
    });
  }
  fail(task: any, error: any, received = false) {
    const { core } = this;
    core.store.transaction(() => {
      const current = core.require('task', task.id),
        attempt = core.require('attempt', task.attempt_id),
        batch = core.require('batch', task.batch_id);
      const paid =
        core.providers.get(current.provider)!.capabilities().paid &&
        ['generate', 'edit'].includes(core.require('plan', current.plan_id).strategy);
      const uncertain =
        received ||
        error?.uncertain === true ||
        (paid && (!error?.code || ['AbortError', 'TimeoutError'].includes(error?.name)));
      const retryable = !uncertain && error?.retryable === true && current.attempt_count < 3;
      const status = uncertain
        ? 'reconciling'
        : current.cancel_requested || batch.status === 'cancelled'
          ? 'cancelled'
          : retryable
            ? 'queued'
            : 'failed';
      if (!uncertain) batch.reserved_usd = Math.max(0, batch.reserved_usd - task.estimated_cost_usd);
      core.store.put('batch', batch);
      const detail = {
        code: String(error?.code ?? 'EXECUTION_FAILED'),
        message:
          paid || batch.vision_review
            ? 'Execution failed; inspect the attempt and reconcile uncertain external outcomes before retrying.'
            : String(error?.message ?? error).slice(0, 600),
        uncertain,
      };
      core.store.put('attempt', {
        ...attempt,
        status: uncertain ? 'unknown' : 'failed',
        error: detail,
        finished_at: now(),
      });
      core.store.saveTask({
        ...transition(current, status),
        lease_owner: null,
        lease_until: null,
        error: detail,
        retry_safe: !uncertain,
        next_run: Date.now() + Math.max(error?.retryAfterMs ?? 0, 1000 * 2 ** current.attempt_count),
      });
      core.updateBatch(batch.id);
      core.store.event(`task.${status}`, task.id, detail);
    });
  }
  async recover() {
    const { core } = this;
    for (const task of core.store.tasks()) {
      if (
        !['running', 'qa_pending', 'reconciling'].includes(task.status) ||
        (task.lease_until ?? 0) > Date.now()
      )
        continue;
      let receipt: ProviderResult | undefined;
      try {
        receipt = JSON.parse(
          await readFile(join(core.root, 'attempts', task.attempt_id, 'receipt.json'), 'utf8'),
        );
      } catch {}
      if (!receipt) {
        try {
          receipt = (await core.providers.get(task.provider)?.getResult(task.attempt_id)) ?? undefined;
        } catch {}
      }
      if (receipt) {
        const claimed = core.store.transaction(() => {
          const fresh = core.require('task', task.id);
          if (
            fresh.status !== task.status ||
            fresh.attempt_id !== task.attempt_id ||
            (fresh.lease_until ?? 0) > Date.now()
          )
            return null;
          fresh.lease_owner = this.workerId;
          fresh.lease_until = Date.now() + this.leaseMs;
          core.store.saveTask(fresh);
          return fresh;
        });
        if (claimed) {
          try {
            await inside(core.root, receipt.path);
            await inspectStored(core.root, receipt.path);
            await this.finish(claimed, receipt);
          } catch (error) {
            this.fail(claimed, error, true);
          }
        }
        continue;
      }
      if (task.status === 'reconciling') continue;
      core.store.transaction(() => {
        const fresh = core.require('task', task.id);
        if (
          (fresh.lease_until ?? 0) > Date.now() ||
          fresh.attempt_id !== task.attempt_id ||
          fresh.status !== task.status
        )
          return;
        fresh.lease_owner = this.workerId;
        core.store.saveTask(fresh);
        const batch = core.require('batch', fresh.batch_id),
          paid =
            (core.providers.get(task.provider)!.capabilities().paid &&
              ['generate', 'edit'].includes(core.require('plan', task.plan_id).strategy)) ||
            (batch.vision_review && fresh.status === 'qa_pending');
        this.failOutsideTransaction(fresh, paid);
      });
    }
  }
  private failOutsideTransaction(task: any, paid: boolean) {
    const { core } = this,
      batch = core.require('batch', task.batch_id);
    if (!paid) batch.reserved_usd = Math.max(0, batch.reserved_usd - task.estimated_cost_usd);
    core.store.put('batch', batch);
    core.store.put('attempt', {
      ...core.require('attempt', task.attempt_id),
      status: paid ? 'unknown' : 'interrupted',
    });
    core.store.saveTask({
      ...transition(task, paid ? 'reconciling' : task.attempt_count < 3 ? 'queued' : 'failed'),
      lease_owner: null,
      lease_until: null,
      error: {
        code: 'WORKER_INTERRUPTED',
        message: paid
          ? 'External result unknown; no automatic resubmission'
          : 'Recovered interrupted local task',
      },
      retry_safe: !paid,
    });
    core.updateBatch(batch.id);
    core.store.event('task.recovered', task.id);
  }
}
