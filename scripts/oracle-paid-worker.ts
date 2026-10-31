/** Authorized Oracle one-attempt E2 entrypoint. Never run by CI; no approval or export is automated. */
import { realpathSync, lstatSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Core, dimensions } from '../packages/core/service.js';
import { Worker } from '../packages/core/worker.js';
import { ValidationRunPolicy, sha } from '../packages/core/validation.js';
import { evaluationSubject } from '../packages/core/evaluation-export.js';
import { validatePlan } from '../packages/planner/index.js';
import { OracleProvider, oracleImagePrompt, oracleAspectRatio } from '../packages/providers/oracle/index.js';
const [mode, root, batchId] = process.argv.slice(2),
  policy = new ValidationRunPolicy();
if (!['--preflight', '--execute-once'].includes(mode) || !root || !batchId)
  throw new Error('Usage: --preflight|--execute-once DATA_ROOT BATCH_ID');
if (!policy.enabled || !policy.approvedSha)
  throw new Error('BLOCKED_EXTERNAL: fresh pinned operator grant and explicit E2 authorization required');
const target = policy.workerTarget(root, batchId);
if (resolve(root) !== realpathSync(root) || lstatSync(join(root, 'creative.sqlite')).isSymbolicLink())
  throw new Error('ISOLATION_REQUIRED');
const provider = new OracleProvider({ stateDir: join(root, 'provider-receipts/oracle') });
let core = new Core(root, new Map([[provider.id, provider]]), true);
try {
  const batch = core.require('batch', batchId),
    plan = core.require('plan', batch.plan_id),
    tasks = core.store.tasks(batchId),
    all = core.store.tasks();
  if (
    batch.project_id !== target.project_id ||
    batch.plan_id !== target.plan_id ||
    tasks.length !== 1 ||
    tasks[0].id !== target.task_id ||
    all.some(
      (t) => t.id !== target.task_id && ['queued', 'running', 'qa_pending', 'reconciling'].includes(t.status),
    )
  )
    throw new Error('WORKER_TARGET_MISMATCH');
  const task = tasks[0];
  if (
    batch.provider !== 'oracle' ||
    batch.vision_review ||
    !['generate', 'edit'].includes(plan.strategy) ||
    task.status !== 'queued' ||
    task.attempt_count !== 0 ||
    task.parent_asset_id
  )
    throw new Error('PRISTINE_SINGLE_IMAGE_ATTEMPT_REQUIRED');
  validatePlan(plan, core.context(plan.project_id, plan.product.truth_snapshot_id));
  const subject = evaluationSubject(core, batchId);
  if (!subject.rights_current) throw new Error('RIGHTS_REVOKED_OR_UNSAFE_SOURCE');
  const size = dimensions(plan.aspect_ratio),
    refs = plan.reference_asset_ids
      .map((id: string) => core.require('asset', id))
      .filter((a: any) => a.kind !== 'document')
      .map((a: any) => sha(readFileSync(a.path))),
    context = policy.context();
  const request = {
    ...context,
    plan_hash: subject.plan_hash,
    rights_hash: subject.rights_hash,
    rights_current: subject.rights_current,
    case_id: subject.case_id,
    action: 'generate_image',
    provider: 'oracle',
    domain: 'chatgpt.com',
    model: provider.model,
    provider_config_hash: sha(JSON.stringify(provider.configuration())),
    input_hash: sha(
      JSON.stringify({
        prompt: oracleImagePrompt(
          task.prompt.text,
          plan.strategy === 'edit',
          refs.length > 0,
          oracleAspectRatio(size.width, size.height),
        ),
        ...size,
        refs,
        mode: plan.strategy === 'edit' ? 'edit' : 'generate',
      }),
    ),
  };
  const cap = policy.validate(request, task.estimated_cost_usd);
  if (cap.max_requests !== 1 || cap.max_images !== 1 || cap.max_attempts !== 1)
    throw new Error('ONE_SHOT_GRANT_REQUIRED');
  const preflight = policy.preflight(request, task.estimated_cost_usd, false);
  if (preflight.status !== 'allowed') throw new Error('BLOCKED_EXTERNAL: ' + preflight.reasons.join(','));
  if (mode === '--preflight') {
    console.log(JSON.stringify({ ...preflight, worker_target_checked: true, executed: false }));
  } else {
    if (process.env.OPENAI_API_KEY) throw new Error('API_CREDENTIAL_MUST_NOT_BE_INHERITED');
    core.close();
    core = new Core(root, new Map([[provider.id, provider]]));
    const worker = new Worker(core, 1),
      claimed = worker.claim();
    if (!claimed || claimed.id !== target.task_id) throw new Error('WORKER_TARGET_CHANGED');
    policy.validate(request, claimed.estimated_cost_usd);
    await worker.execute(claimed);
    const result = core.batch(batchId);
    const finalTask = core.require('task', claimed.id);
    if (finalTask.status !== 'review_pending' || !finalTask.asset_id)
      throw new Error(
        'ORACLE_RESULT_REQUIRES_RECONCILIATION: ' +
          JSON.stringify({ status: finalTask.status, error: finalTask.error }),
      );
    console.log(
      JSON.stringify({
        batch_id: batchId,
        task_id: claimed.id,
        attempt_id: claimed.attempt_id,
        status: result.status,
        cost_summary: result.cost_summary,
        human_approval: 'pending',
        business_status: 'not_evaluable',
        provider: 'oracle',
        api_cost_usd: 0,
        subscription_cost: 'unmetered',
        asset_id: finalTask.asset_id,
      }),
    );
  }
} finally {
  core.close();
  await provider.close();
}
