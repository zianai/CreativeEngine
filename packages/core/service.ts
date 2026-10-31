import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ZipArchive } from 'archiver';
import { z } from 'zod';
import {
  BriefSchema,
  TruthSnapshotSchema,
  SourceInputSchema,
  ReviewSchema,
  AppError,
} from '../contracts/index.js';
import { createPlan, validatePlan, loadSkills, loadDeliveryRules, compilePrompt } from '../planner/index.js';
import {
  createProviders,
  providerConfiguration,
  validateProviderResult,
  type ImageProvider,
} from '../providers/index.js';
import { Store, id, now } from './store.js';
import { acceptFile, hash, inside, inspectStored } from './files.js';
import { transition } from './state.js';

export class Core {
  readonly store: Store;
  readonly providers: Map<string, ImageProvider>;
  readonly root: string;
  constructor(
    root = resolve(process.env.CREATIVE_DATA_DIR ?? '.creative-engine'),
    providers?: Map<string, ImageProvider>,
    readOnly = false,
  ) {
    this.root = resolve(root);
    this.store = new Store(this.root, readOnly);
    this.providers = providers ?? createProviders(this.root);
  }
  require(kind: string, entityId: string) {
    const v = kind === 'task' ? this.store.task(entityId) : this.store.get(kind, entityId);
    if (!v) throw new AppError('NOT_FOUND', `${kind} ${entityId} not found`, 404);
    return v;
  }
  project(input: unknown) {
    const p = z
      .object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(4000).default(''),
        product_id: z.string().max(200).optional(),
      })
      .parse(input);
    return this.store.put('project', { ...p, id: id('prj'), created_at: now() });
  }
  async importAsset(input: unknown) {
    const s = SourceInputSchema.parse(input);
    this.require('project', s.project_id);
    let meta;
    try {
      meta = await acceptFile(this.root, s);
    } catch (e) {
      throw new AppError('UNSAFE_ASSET', (e as Error).message);
    }
    const derived = this.store.list('asset').find((a) => a.sha256 === meta.sha256 && a.identity !== 'source');
    if (
      derived &&
      !this.store.list('asset').some((a) => a.sha256 === meta.sha256 && a.identity === 'source')
    ) {
      await rm(meta.path, { force: true });
      throw new AppError(
        'DERIVED_ASSET_REIMPORT',
        'Known generated or derived output cannot be re-imported as original Product Truth evidence; use its existing asset identity.',
      );
    }
    const { data_base64, ...rest } = s;
    const a = this.store.put('asset', {
      ...rest,
      ...meta,
      id: id('src'),
      identity: 'source',
      review_status: 'pending',
      created_at: now(),
    });
    this.store.event('asset.imported', a.id);
    return this.asset(a.id);
  }
  truth(input: unknown) {
    const p = TruthSnapshotSchema.parse(input);
    this.require('project', p.project_id);
    for (const f of p.facts) {
      const source = this.require('asset', f.source_asset_id);
      if (
        source.project_id !== p.project_id ||
        source.identity !== 'source' ||
        !source.authorized ||
        source.source_version !== f.source_version
      )
        throw new AppError(
          'INVALID_EVIDENCE',
          'Facts require original authorized evidence of the declared source version',
        );
      if (f.evidence_status === 'verified' && !source.verified)
        throw new AppError('UNVERIFIED_SOURCE', 'Verified facts require verified evidence');
      if (f.external_allowed && f.evidence_status !== 'verified')
        throw new AppError('UNVERIFIED_CLAIM', 'Only verified facts can be cleared for external use');
    }
    const truth = { ...p, id: id('truth'), created_at: now() };
    this.store.put('truth', truth);
    this.store.event('truth.created', truth.id);
    return truth;
  }
  brief(input: unknown) {
    const brief = BriefSchema.parse(input);
    this.require('project', brief.project_id);
    const b = { ...brief, id: id('brief'), created_at: now() };
    this.store.put('brief', b);
    return b;
  }
  context(projectId: string, truthId?: string) {
    const truth = truthId ? this.require('truth', truthId) : undefined;
    if (truth && truth.project_id !== projectId)
      throw new AppError('CROSS_PROJECT', 'Truth snapshot belongs to another project');
    return { assets: this.store.list('asset', projectId), truth };
  }
  plan(briefId: string) {
    const b = this.require('brief', briefId);
    const plan = createPlan(b, this.context(b.project_id, b.product.truth_snapshot_id));
    this.store.put('plan', plan);
    this.store.event('plan.created', plan.id);
    return plan;
  }
  async providerList() {
    return Promise.all(
      [...this.providers.values()].map(async (p) => ({
        id: p.id,
        capabilities: p.capabilities(),
        health: await p.healthCheck().catch(() => ({ status: 'unavailable' })),
      })),
    );
  }
  skills() {
    return loadSkills();
  }
  deliveryRules() {
    return loadDeliveryRules();
  }
  createBatch(input: any) {
    const v = z
      .object({
        plan_id: z.string(),
        budget_usd: z.number().min(0).max(10000),
        authorize_paid: z.boolean().default(false),
        vision_review: z.boolean().default(false),
        idempotency_key: z.string().min(1).max(200).optional(),
        provider: z.string().optional(),
      })
      .parse(input);
    const plan = this.require('plan', v.plan_id);
    validatePlan(plan, this.context(plan.project_id, plan.product.truth_snapshot_id));
    const providerId = v.provider ?? plan.provider;
    const provider = this.providers.get(providerId);
    if (!provider) throw new AppError('PROVIDER_UNKNOWN', 'Unknown provider');
    const visionConfig = v.vision_review ? visionConfiguration() : undefined;
    const providerConfig = providerConfiguration(provider),
      providerConfigHash = hash(JSON.stringify(providerConfig));
    const capabilities = provider.capabilities();
    if (
      (plan.strategy === 'generate' && !capabilities.generate) ||
      (plan.strategy === 'edit' && !capabilities.edit)
    )
      throw new AppError('UNSUPPORTED_CAPABILITY', 'Provider does not support this strategy');
    const paid = capabilities.paid && ['generate', 'edit'].includes(plan.strategy);
    if ((paid || v.vision_review) && !v.authorize_paid)
      throw new AppError('PAID_AUTHORIZATION_REQUIRED', 'Explicit paid authorization is required');
    if (
      plan.mode === 'base_variants' &&
      plan.strategy === 'generate' &&
      plan.variants * plan.scenes.length > 1 &&
      !capabilities.edit
    )
      throw new AppError('UNSUPPORTED_CAPABILITY', 'Base-derived variants require provider edit capability');
    if (providerId === 'oracle' && plan.variants * plan.scenes.length > 1)
      throw new AppError('ORACLE_CONTROLLED_ONLY', 'Oracle supports controlled single-image runs only');
    const fingerprint = hash(
      JSON.stringify({
        plan,
        provider: providerId,
        provider_config: providerConfig,
        budget: v.budget_usd,
        paid: v.authorize_paid,
        vision: visionConfig,
        assets: [...plan.reference_asset_ids, plan.authorized_logo_asset_id, plan.background_asset_id]
          .filter(Boolean)
          .map((i: string) => this.require('asset', i).sha256),
      }),
    );
    return this.store.transaction(() => {
      if (v.idempotency_key) {
        const prior = this.store.db
          .prepare('SELECT * FROM idempotency WHERE key=?')
          .get(v.idempotency_key) as any;
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for different inputs', 409);
          return this.batch(prior.batch_id);
        }
      }
      const batch: any = {
        id: id('batch'),
        project_id: plan.project_id,
        plan_id: plan.id,
        provider: providerId,
        provider_config: providerConfig,
        provider_config_hash: providerConfigHash,
        status: 'queued',
        budget_usd: v.budget_usd,
        cost_usd: 0,
        reserved_usd: 0,
        authorize_paid: v.authorize_paid,
        vision_review: v.vision_review,
        vision_config: visionConfig,
        created_at: now(),
        fingerprint,
      };
      let baseTaskId: string | undefined;
      let estimate = 0;
      for (const scene of plan.scenes)
        for (let variant = 0; variant < plan.variants; variant++) {
          const taskId = id('task');
          const prompt = compilePrompt(plan, {
            scene,
            variant,
            direction: plan.directions[variant % plan.directions.length],
          });
          const cost = paid
            ? provider.estimateCost({
                taskId,
                attemptId: 'estimate',
                prompt: prompt.text,
                outputDir: '',
                ...dimensions(plan.aspect_ratio),
                referencePaths: [],
              })
            : 0;
          if (!Number.isFinite(cost) || cost < 0 || (paid && providerId !== 'oracle' && cost === 0))
            throw new AppError(
              'INVALID_COST_ESTIMATE',
              'Provider must declare a finite positive paid-call reservation',
            );
          const taskCost = cost + (visionConfig?.reservation_usd ?? 0);
          estimate += taskCost;
          const t = {
            id: taskId,
            project_id: plan.project_id,
            batch_id: batch.id,
            plan_id: plan.id,
            status: 'queued',
            scene,
            variant,
            direction: plan.directions[variant % plan.directions.length],
            prompt,
            provider: providerId,
            estimated_cost_usd: taskCost,
            image_estimated_cost_usd: cost,
            attempt_count: 0,
            dependency_task_id: plan.mode === 'base_variants' ? baseTaskId : undefined,
            created_at: now(),
          };
          this.store.saveTask(t);
          baseTaskId ??= taskId;
        }
      if (estimate > v.budget_usd + 1e-9)
        throw new AppError(
          'BUDGET_EXCEEDED',
          `Estimated cost $${estimate.toFixed(4)} exceeds budget $${v.budget_usd.toFixed(4)}`,
        );
      batch.estimated_cost_usd = estimate;
      this.store.put('batch', batch);
      if (v.idempotency_key)
        this.store.db
          .prepare('INSERT INTO idempotency VALUES(?,?,?)')
          .run(v.idempotency_key, fingerprint, batch.id);
      this.store.event('batch.created', batch.id, { task_count: plan.variants * plan.scenes.length });
      return this.batch(batch.id);
    });
  }
  batch(batchId: string) {
    const b = this.require('batch', batchId);
    const tasks = this.store.tasks(batchId),
      ids = new Set(tasks.map((t) => t.id));
    const attempts = this.store.list('attempt').filter((a) => ids.has(a.task_id));
    const unknown =
      tasks.some((t) => t.status === 'reconciling') ||
      attempts.some((a) => ['unknown', 'review_uncertain'].includes(a.status));
    const imageCost = attempts.reduce((sum, a) => sum + Number(a.image_cost_usd ?? 0), 0);
    const visionCost = attempts.reduce((sum, a) => sum + Number(a.vision_cost_usd ?? 0), 0);
    const paid = Boolean(b.authorize_paid && (b.provider !== 'mock' || b.vision_review));
    const approved = this.store
      .list('asset', b.project_id)
      .filter((a) => a.batch_id === batchId && a.review_status === 'approved').length;
    return {
      ...b,
      tasks: tasks.map((t) => this.publicTask(t)),
      cost_summary: {
        charge_status: unknown ? 'unknown' : paid ? 'estimated' : 'actual',
        actual_cost_usd: unknown || paid ? null : b.cost_usd,
        gross_spend_estimated_usd: b.cost_usd,
        image_cost_estimated_usd: imageCost,
        vision_review_cost_estimated_usd: visionCost,
        unknown_liability_usd: unknown
          ? b.reserved_usd +
            attempts
              .filter((a) => a.status === 'review_uncertain')
              .reduce((sum, a) => sum + Number(a.vision_cost_usd ?? 0), 0)
          : 0,
        approved_assets: approved,
        cost_per_approved_asset: unknown || !approved ? null : b.cost_usd / approved,
        cost_per_approved_asset_basis: unknown ? 'unknown' : paid ? 'estimated' : 'actual',
      },
    };
  }
  publicTask(t: any) {
    const { lease_owner, lease_until, ...safe } = t;
    return safe;
  }
  updateBatch(batchId: string) {
    const b = this.require('batch', batchId),
      tasks = this.store.tasks(batchId);
    if (['paused', 'cancelled'].includes(b.status)) return b;
    const states = tasks.map((t) => t.status);
    b.status = states.every((s) => s === 'approved' || s === 'completed')
      ? 'approved'
      : states.includes('running') || states.includes('qa_pending')
        ? 'running'
        : states.includes('reconciling')
          ? 'reconciling'
          : states.includes('queued')
            ? 'queued'
            : states.includes('blocked')
              ? 'blocked'
              : states.includes('failed')
                ? 'failed'
                : states.some((s) => s === 'review_pending' || s === 'rejected' || s === 'revision_pending')
                  ? 'review_pending'
                  : 'completed';
    return this.store.put('batch', b);
  }
  controlBatch(batchId: string, action: string) {
    return this.store.transaction(() => {
      const b = this.require('batch', batchId);
      if (action === 'cancel') {
        b.status = 'cancelled';
        for (const t of this.store.tasks(batchId)) {
          if (['queued', 'failed', 'blocked'].includes(t.status))
            this.store.saveTask(transition(t, 'cancelled'));
          else if (['running', 'qa_pending'].includes(t.status))
            this.store.saveTask({ ...t, cancel_requested: true });
        }
      } else if (action === 'pause') {
        if (b.status === 'cancelled') throw new AppError('INVALID_STATE', 'Cancelled batch cannot pause');
        b.status = 'paused';
      } else if (action === 'resume') {
        if (b.status === 'cancelled') throw new AppError('INVALID_STATE', 'Cancelled batch is terminal');
        b.status = 'queued';
        for (const t of this.store.tasks(batchId)) {
          if (t.status === 'failed' && t.retry_safe && t.attempt_count < 3)
            this.store.saveTask({ ...transition(t, 'queued'), next_run: 0 });
        }
      } else throw new AppError('INVALID_ACTION', 'Invalid batch action');
      this.store.put('batch', b);
      if (action === 'resume') this.updateBatch(batchId);
      this.store.event(`batch.${action}`, batchId);
      return this.batch(batchId);
    });
  }
  asset(assetId: string) {
    const a = this.require('asset', assetId);
    const { path, ...safe } = a;
    return {
      ...safe,
      url: `/v1/assets/${assetId}/file`,
      qa: a.qa_id ? this.store.get('qa', a.qa_id) : null,
      provenance: {
        reference_asset_ids: a.reference_asset_ids ?? [],
        background_asset_id: a.background_asset_id,
        authorized_logo_asset_id: a.authorized_logo_asset_id,
        truth_snapshot_id: a.truth_snapshot_id,
        skill_version: a.skill_version,
        prompt: a.prompt,
        provider: a.provider,
        model: a.model,
        parent_asset_id: a.parent_asset_id,
        attempt_id: a.attempt_id,
      },
      reviews: this.store.list('review').filter((r) => r.asset_id === assetId),
    };
  }
  review(assetId: string, input: unknown) {
    const review = ReviewSchema.parse(input);
    const a = this.require('asset', assetId);
    if (a.identity === 'source')
      throw new AppError('SOURCE_NOT_OUTPUT', 'Review applies to production outputs');
    const qa = this.require('qa', a.qa_id);
    if (
      lstatSync(a.path).isSymbolicLink() ||
      !realpathSync(a.path).startsWith(realpathSync(this.root) + '/') ||
      hash(readFileSync(a.path)) !== a.sha256
    )
      throw new AppError('ASSET_TAMPERED', 'ASSET_TAMPERED: exact asset bytes changed; review blocked');
    if (!['pass', 'warn', 'block'].includes(qa.status))
      throw new AppError('QA_UNKNOWN', 'Unknown QA status cannot authorize a business asset');
    if (review.decision === 'approved' && qa.status === 'block')
      throw new AppError('QA_BLOCKED', 'Blocking QA issues cannot be bypassed by review');
    if (review.decision === 'approved') this.assertCurrentAsset(a);
    return this.store.transaction(() => {
      const t = this.require('task', a.task_id);
      if (!['review_pending', 'approved'].includes(t.status))
        throw new AppError('INVALID_STATE', 'Only current review candidates may be reviewed');
      const decision = {
        ...review,
        asset_sha256: a.sha256,
        plan_id: t.plan_id,
        id: id('review'),
        project_id: a.project_id,
        asset_id: assetId,
        created_at: now(),
      };
      this.store.put('review', decision);
      this.store.put('asset', { ...a, review_status: review.decision });
      this.store.saveTask(transition(t, review.decision));
      this.updateBatch(t.batch_id);
      this.store.event('asset.reviewed', assetId, { decision: review.decision });
      return this.asset(assetId);
    });
  }
  revise(taskId: string, input: any) {
    return this.store.transaction(() => {
      const v = z
        .object({
          instructions: z.string().trim().min(1).max(4000),
          allowed_changes: z.array(z.string()).optional(),
          budget_usd: z.number().nonnegative().default(0),
          authorize_paid: z.boolean().default(false),
        })
        .parse(input);
      const t = this.require('task', taskId),
        plan = this.require('plan', t.plan_id);
      if (!['review_pending', 'rejected', 'approved'].includes(t.status))
        throw new AppError('INVALID_STATE', 'Revision requires an existing review candidate');
      if (v.allowed_changes?.some((c) => !plan.allowed_changes.includes(c)))
        throw new AppError('CHANGE_NOT_AUTHORIZED', 'Revision cannot expand the approved change scope');
      if (
        ['generate', 'edit'].includes(plan.strategy) &&
        !this.providers.get(t.provider)?.capabilities().edit
      )
        throw new AppError('UNSUPPORTED_CAPABILITY', 'Revision requires provider editing support');
      const controls = revisionControls(plan, v.instructions);
      const revisionPlan = {
        ...plan,
        id: id('plan'),
        version: plan.version + 1,
        variants: 1,
        scenes: [t.scene],
        mode: 'iterative',
        created_at: now(),
        parent_plan_id: plan.id,
      };
      this.store.put('plan', revisionPlan);
      const b = this.createBatch({
        plan_id: revisionPlan.id,
        budget_usd: v.budget_usd,
        authorize_paid: v.authorize_paid,
        provider: t.provider,
        vision_review: this.require('batch', t.batch_id).vision_review,
      });
      const child = this.store.tasks(b.id)[0];
      child.parent_asset_id = t.asset_id;
      child.revision_instructions = v.instructions;
      child.revision_controls = controls;
      child.prompt = compilePrompt(revisionPlan, {
        scene: t.scene,
        variant: t.variant,
        direction: t.direction,
        revision: v.instructions,
      });
      this.store.saveTask(child);
      this.store.saveTask(transition(t, 'revision_pending'));
      this.store.event('task.revised', t.id, { batch_id: b.id, task_id: child.id });
      return this.batch(b.id);
    });
  }
  async export(input: any) {
    const v = z
      .object({ batch_id: z.string(), asset_ids: z.array(z.string()).min(1).optional() })
      .parse(input);
    const b = this.require('batch', v.batch_id);
    const all = this.store.list('asset', b.project_id).filter((a) => a.batch_id === b.id);
    const assets = v.asset_ids
      ? v.asset_ids.map((i) => this.require('asset', i))
      : all.filter((a) => a.review_status === 'approved');
    if (!assets.length)
      throw new AppError(all.length ? 'UNAPPROVED_ASSET' : 'NO_ASSETS', 'No approved assets to export');
    for (const a of assets) {
      this.assertCurrentAsset(a);
      if (
        a.batch_id !== b.id ||
        a.review_status !== 'approved' ||
        this.require('qa', a.qa_id).status === 'block'
      )
        throw new AppError('UNAPPROVED_ASSET', 'Only approved assets from this batch can be exported');
      const metadata = await import('./files.js').then((m) => m.inspectStored(this.root, a.path));
      if (metadata.sha256 !== a.sha256) throw new AppError('ASSET_TAMPERED', 'Asset hash mismatch');
    }
    const exportId = id('export'),
      dir = join(this.root, 'exports');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${exportId}.zip`);
    const exportPlan = this.require('plan', b.plan_id),
      external = exportPlan.delivery_target !== 'internal_review';
    const manifest = {
      schema_version: '1.0.0',
      audience: external ? 'external' : 'internal',
      id: exportId,
      batch_id: b.id,
      created_at: now(),
      project: external ? { id: b.project_id } : this.require('project', b.project_id),
      plan: external
        ? {
            id: exportPlan.id,
            version: exportPlan.version,
            workflow: exportPlan.workflow,
            source: exportPlan.source,
            strategy: exportPlan.strategy,
            fidelity: exportPlan.fidelity,
            product: exportPlan.product,
            delivery_target: exportPlan.delivery_target,
            skill_version: exportPlan.skill_version,
          }
        : exportPlan,
      truth_snapshots: [...new Set(assets.map((a) => a.truth_snapshot_id).filter(Boolean))].map((i) => {
        const truth = this.require('truth', i as string);
        return external
          ? {
              ...truth,
              facts: truth.facts.filter((f: any) => f.evidence_status === 'verified' && f.external_allowed),
              redacted: true,
              snapshot_sha256: hash(JSON.stringify(truth)),
            }
          : truth;
      }),
      assets: assets.map((a, index) => ({
        ...this.exportAsset(a.id, external),
        export_filename: `${String(index + 1).padStart(3, '0')}_${a.identity}_${a.id}.${a.format === 'jpeg' ? 'jpg' : a.format}`,
      })),
      mock: assets.some((a) => a.identity === 'mock'),
      external_use_warning: assets.some((a) => a.identity === 'mock')
        ? 'MOCK DEMONSTRATION — not actual AI-generated or commercial product proof'
        : null,
    };
    await new Promise<void>((ok, fail) => {
      const out = createWriteStream(path, { flags: 'wx' }),
        zip = new ZipArchive({ zlib: { level: 6 } });
      out.on('close', ok);
      out.on('error', fail);
      zip.on('error', fail);
      zip.pipe(out);
      for (let i = 0; i < assets.length; i++)
        zip.file(assets[i].path, { name: manifest.assets[i].export_filename });
      zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      void zip.finalize();
    });
    try {
      for (const a of assets) {
        this.assertCurrentAsset(this.require('asset', a.id));
        if (this.require('asset', a.id).review_status !== 'approved')
          throw new AppError('APPROVAL_REVOKED', 'Approval changed during export; package discarded');
      }
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    const result = this.store.put('export', {
      id: exportId,
      project_id: b.project_id,
      batch_id: b.id,
      path,
      sha256: hash(await readFile(path)),
      manifest,
      created_at: now(),
      download_url: `/v1/exports/${exportId}/file`,
    });
    this.store.event('export.created', exportId);
    const { path: _, ...safe } = result;
    return safe;
  }
  async reconcile(taskId: string, input: unknown) {
    const v = z
      .object({
        outcome: z.enum(['no_charge', 'failed_charged']),
        cost_usd: z.number().finite().nonnegative().max(100000),
        reviewer: z.string().trim().min(1).max(200),
        evidence: z.string().trim().min(12).max(8000),
      })
      .parse(input);
    const task = this.require('task', taskId);
    if (task.status !== 'reconciling')
      throw new AppError('INVALID_STATE', 'Only ambiguous calls may be reconciled');
    if (v.outcome === 'no_charge' && v.cost_usd !== 0)
      throw new AppError('INVALID_COST', 'No-charge reconciliation requires zero cost');
    let receipt = false;
    const validateReceipt = async (result: unknown) => {
      validateProviderResult(result);
      await inside(this.root, (result as any).path);
      await inspectStored(this.root, (result as any).path);
      receipt = true;
    };
    try {
      await validateReceipt(
        JSON.parse(await readFile(join(this.root, 'attempts', task.attempt_id, 'receipt.json'), 'utf8')),
      );
    } catch {}
    try {
      const result = await this.providers.get(task.provider)?.getResult(task.attempt_id);
      if (result) await validateReceipt(result);
    } catch {}
    if (receipt)
      throw new AppError(
        'RECEIPT_AVAILABLE',
        'A result receipt exists; let the worker recover it instead of resolving as failed',
      );
    return this.store.transaction(() => {
      const current = this.require('task', taskId);
      if (current.status !== 'reconciling' || current.attempt_id !== task.attempt_id)
        throw new AppError('STATE_CHANGED', 'Task changed during reconciliation', 409);
      const batch = this.require('batch', task.batch_id);
      batch.reserved_usd = Math.max(0, batch.reserved_usd - task.estimated_cost_usd);
      batch.cost_usd += v.cost_usd;
      this.store.put('batch', batch);
      const record = {
        id: id('reconciliation'),
        project_id: task.project_id,
        task_id: task.id,
        attempt_id: task.attempt_id,
        ...v,
        created_at: now(),
      };
      this.store.put('reconciliation', record);
      this.store.put('attempt', {
        ...this.require('attempt', task.attempt_id),
        status: 'failed',
        cost_usd: v.cost_usd,
        reconciliation_id: record.id,
        finished_at: now(),
      });
      this.store.saveTask({
        ...transition(current, 'failed'),
        retry_safe: v.outcome === 'no_charge',
        lease_owner: null,
        lease_until: null,
        error: { code: 'RECONCILED', message: v.outcome },
      });
      this.updateBatch(batch.id);
      this.store.event('task.reconciled', task.id, { outcome: v.outcome, reconciliation_id: record.id });
      return this.publicTask(this.require('task', task.id));
    });
  }
  exportReady(exportId: string) {
    const pkg = this.require('export', exportId);
    for (const a of pkg.manifest.assets) {
      const current = this.require('asset', a.id);
      this.assertCurrentAsset(current);
      if (current.review_status !== 'approved' || current.sha256 !== a.sha256)
        throw new AppError('APPROVAL_REVOKED', 'Package contains an asset whose approval has been revoked');
    }
    if (!pkg.sha256 || hash(readFileSync(pkg.path)) !== pkg.sha256)
      throw new AppError('EXPORT_TAMPERED', 'Export hash missing or changed; create a fresh package');
    return pkg;
  }
  /** The saved plan is immutable; current source rights and bytes are not inferred from old QA. */
  assertCurrentAsset(asset: any) {
    const task = this.require('task', asset.task_id),
      plan = this.require('plan', task.plan_id);
    validatePlan(plan, this.context(plan.project_id, plan.product.truth_snapshot_id));
    const ids = new Set<string>([
      ...plan.reference_asset_ids,
      ...(plan.background_asset_id ? [plan.background_asset_id] : []),
      ...(plan.authorized_logo_asset_id ? [plan.authorized_logo_asset_id] : []),
      ...(plan.product.truth_snapshot_id
        ? this.require('truth', plan.product.truth_snapshot_id).facts.map((f: any) => f.source_asset_id)
        : []),
    ]);
    for (const record of [asset, ...[...ids].map((id) => this.require('asset', id))]) {
      if (record.project_id !== asset.project_id)
        throw new AppError('CROSS_PROJECT', 'Asset provenance belongs to another project');
      if (record.identity === 'source' && (!record.authorized || !record.sensitive_data_cleared))
        throw new AppError('SOURCE_STALE', 'Source rights are no longer current');
      if (
        lstatSync(record.path).isSymbolicLink() ||
        !realpathSync(record.path).startsWith(realpathSync(this.root) + '/') ||
        hash(readFileSync(record.path)) !== record.sha256
      )
        throw new AppError('ASSET_TAMPERED', 'Asset hash changed; approval and export blocked');
    }
    const qa = this.require('qa', asset.qa_id);
    if (!['pass', 'warn'].includes(qa.status))
      throw new AppError('QA_BLOCKED', 'Current QA does not permit approval or export');
  }
  async purgeProject(projectId: string, confirmName?: string) {
    const p = this.require('project', projectId),
      tasks = this.store.tasks().filter((t) => t.project_id === projectId);
    if (tasks.some((t) => ['queued', 'running', 'qa_pending', 'reconciling'].includes(t.status)))
      throw new AppError('ACTIVE_PROJECT', 'Cancel or reconcile active tasks before cleanup');
    const entities = this.store.db
      .prepare('SELECT kind,id,data FROM entities WHERE project_id=? OR (kind=? AND id=?)')
      .all(projectId, 'project', projectId) as any[];
    const report = {
      project_id: projectId,
      name: p.name,
      records: entities.length,
      tasks: tasks.length,
      dry_run: confirmName === undefined,
    };
    if (confirmName === undefined) return report;
    if (confirmName !== p.name)
      throw new AppError(
        'CONFIRMATION_MISMATCH',
        'Exact project name is required for permanent local cleanup',
      );
    const managed = entities
      .map((e) => JSON.parse(e.data))
      .filter((e) => e.path)
      .map((e) => e.path as string);
    for (const path of managed) await inside(this.root, path);
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM jobs WHERE project_id=?').run(projectId);
      this.store.db
        .prepare('DELETE FROM entities WHERE project_id=? OR (kind=? AND id=?)')
        .run(projectId, 'project', projectId);
      for (const b of entities.filter((e) => e.kind === 'batch'))
        this.store.db.prepare('DELETE FROM idempotency WHERE batch_id=?').run(b.id);
      for (const e of entities) this.store.db.prepare('DELETE FROM events WHERE entity_id=?').run(e.id);
      for (const t of tasks) this.store.db.prepare('DELETE FROM events WHERE entity_id=?').run(t.id);
    });
    for (const path of managed) await rm(path, { force: true });
    for (const e of entities.filter((e) => e.kind === 'attempt')) {
      await rm(join(this.root, 'attempts', e.id), { recursive: true, force: true });
      const attempt = JSON.parse(e.data);
      if (/^[a-z0-9_-]+$/i.test(attempt.provider))
        await rm(join(this.root, 'provider-receipts', attempt.provider, `${e.id}.json`), { force: true });
    }
    return { ...report, dry_run: false };
  }
  exportAsset(assetId: string, external: boolean) {
    const a = this.asset(assetId);
    if (!external) return a;
    const { prompt, reviews, qa, provenance, ...safe } = a;
    const { prompt: _, ...trace } = provenance;
    return {
      ...safe,
      provenance: trace,
      reviews: reviews.map((r: any) => ({ id: r.id, decision: r.decision, created_at: r.created_at })),
      qa: {
        status: qa.status,
        checks: qa.checks.map((c: any) => ({ name: c.name, status: c.status })),
        vision: { status: qa.vision.status },
      },
    };
  }
  async file(assetId: string) {
    const a = this.require('asset', assetId);
    return inside(this.root, a.path);
  }
  dashboard() {
    const batches = this.store.list('batch'),
      assets = this.store.list('asset');
    return {
      projects: this.store.list('project').length,
      batches: batches.length,
      assets: assets.length,
      review_pending: assets.filter((a) => a.review_status === 'pending' && a.identity !== 'source').length,
      cost_usd: batches.reduce((sum, b) => sum + b.cost_usd, 0),
      reserved_usd: batches.reduce((sum, b) => sum + b.reserved_usd, 0),
    };
  }
  operationsStatus() {
    const tasks = this.store.tasks(),
      attempts = this.store.list('attempt');
    const count = (states: string[]) => tasks.filter((t) => states.includes(t.status)).length;
    return {
      topology: 'single_host_trusted_loopback',
      production_ready: false,
      queue_depth: count(['queued']),
      running: count(['running', 'qa_pending']),
      pending_review: count(['review_pending']),
      reconciling: count(['reconciling']),
      uncertain_vision: attempts.filter((a) => a.status === 'review_uncertain').length,
      blocked: count(['blocked']),
      failed: count(['failed']),
      alerts: [
        ...(count(['reconciling']) ? ['RECONCILIATION_REQUIRED'] : []),
        ...(attempts.some((a) => a.status === 'review_uncertain') ? ['VISION_OUTCOME_UNKNOWN'] : []),
        ...(count(['queued']) > 100 ? ['QUEUE_BACKLOG'] : []),
        ...(count(['blocked', 'failed']) ? ['TASK_FAILURE_REVIEW'] : []),
      ],
      sampled_at: now(),
      billing_actual_usd: null,
    };
  }
  close() {
    for (const provider of this.providers.values()) {
      const close = (provider as ImageProvider & { close?: () => Promise<void> }).close;
      if (close) void close.call(provider).catch(() => {});
    }
    this.store.close();
  }
}
export function dimensions(ratio: string) {
  if (ratio === '16:9') return { width: 1536, height: 864 };
  if (ratio === '9:16') return { width: 864, height: 1536 };
  const [a, b] = ratio.split(':').map(Number);
  return a >= b
    ? { width: 1024, height: Math.round((1024 * b) / a) }
    : { width: Math.round((1024 * a) / b), height: 1024 };
}

export function revisionControls(plan: any, instructions: string) {
  if (!['reuse', 'compose'].includes(plan.strategy)) return {};
  const controls: any = {};
  const colors: Record<string, string> = {
    white: '#ffffff',
    black: '#161a18',
    warm: '#eadac6',
    cream: '#f3ead8',
    green: '#dbe7db',
    blue: '#dce7ef',
    red: '#eedbd7',
    白: '#ffffff',
    黑: '#161a18',
    暖: '#eadac6',
    绿: '#dbe7db',
    蓝: '#dce7ef',
    红: '#eedbd7',
  };
  if (/background|背景/i.test(instructions) && plan.allowed_changes.includes('background')) {
    const value =
      instructions.match(/#[0-9a-f]{6}/i)?.[0] ??
      Object.entries(colors).find(([word]) => instructions.toLowerCase().includes(word))?.[1];
    if (value) controls.background = value;
  }
  if (
    /colou?r|颜色|配色/i.test(instructions) &&
    plan.allowed_changes.includes('color') &&
    plan.fidelity === 'controlled'
  ) {
    const value = instructions.match(/#[0-9a-f]{6}/i)?.[0];
    if (value) controls.color = value;
  }
  if (!Object.keys(controls).length)
    throw new AppError(
      'REVISION_NEEDS_INPUT',
      'Deterministic revision supports an authorized background color or cutout color. Specify e.g. background #e6dfd0; other edits need a new approved plan.',
    );
  return controls;
}

function visionConfiguration() {
  const model = process.env.CREATIVE_VISION_MODEL,
    reservation = Number(process.env.CREATIVE_VISION_RESERVATION_USD),
    input = Number(process.env.CREATIVE_VISION_INPUT_USD_PER_MILLION),
    output = Number(process.env.CREATIVE_VISION_OUTPUT_USD_PER_MILLION);
  if (
    !model ||
    !process.env.OPENAI_API_KEY ||
    ![reservation, input, output].every((n) => Number.isFinite(n) && n > 0)
  )
    throw new AppError(
      'VISION_NOT_CONFIGURED',
      'Vision QA requires a configured model, credentials, reservation, and input/output token rates.',
    );
  return {
    model,
    reservation_usd: reservation,
    input_usd_per_million: input,
    output_usd_per_million: output,
  };
}
