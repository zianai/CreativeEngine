/** Authorized read-only export of a pinned subject. Never classifies existing data as synthetic. */
import { realpathSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { Core } from './service.js';
import { hash } from './files.js';
import { ValidationRunPolicy } from './validation.js';
import { evaluationSnapshot } from './evaluation.js';

export function evaluationSubject(core: Core, batchId: string) {
  const batch = core.require('batch', batchId),
    plan = core.require('plan', batch.plan_id);
  const truth = plan.product.truth_snapshot_id ? core.require('truth', plan.product.truth_snapshot_id) : null;
  const ids = [
    ...new Set<string>(
      [
        ...plan.reference_asset_ids,
        plan.authorized_logo_asset_id,
        plan.background_asset_id,
        ...(truth?.facts ?? []).map((f: any) => f.source_asset_id),
      ].filter(Boolean),
    ),
  ].sort();
  const sources = ids.map((id) => core.require('asset', id));
  return {
    case_id: plan.source?.case_id ?? plan.project_id,
    plan_hash: hash(JSON.stringify(plan)),
    input_hash: hash(
      JSON.stringify({ sources: sources.map((a) => ({ id: a.id, sha256: a.sha256 })), truth }),
    ),
    rights_hash: hash(
      JSON.stringify(
        sources.map((a) => ({
          id: a.id,
          authorized: a.authorized,
          sensitive_data_cleared: a.sensitive_data_cleared,
          identity: a.identity,
          source_version: a.source_version,
        })),
      ),
    ),
    provider_config_hash: batch.provider_config_hash,
    rights_current: sources.every(
      (a) =>
        a.project_id === batch.project_id &&
        a.identity === 'source' &&
        a.authorized === true &&
        a.sensitive_data_cleared === true &&
        resolve(a.path).startsWith(core.root + sep) &&
        !lstatSync(a.path).isSymbolicLink() &&
        realpathSync(a.path) === resolve(a.path) &&
        hash(readFileSync(a.path)) === a.sha256,
    ),
  };
}
export function authorizedEvaluation(
  policy: ValidationRunPolicy,
  root: string,
  batchId: string,
  classification: string,
) {
  if (!['public', 'redacted_business', 'sensitive_business'].includes(classification))
    throw new Error('EXISTING_DATA_CANNOT_BE_RELABELLED_SYNTHETIC');
  if (!policy.enabled || !policy.approvedSha)
    throw new Error('BLOCKED_EXTERNAL: operator data-read grant required');
  const target = policy.evaluationTarget(root, batchId, classification);
  if (resolve(root) !== realpathSync(root)) throw new Error('ISOLATION_REQUIRED');
  const databasePath = join(root, 'creative.sqlite');
  if (lstatSync(databasePath).isSymbolicLink() || realpathSync(databasePath) !== resolve(databasePath))
    throw new Error('ISOLATION_REQUIRED');
  const core = new Core(root, new Map(), true);
  try {
    core.store.db.exec('BEGIN');
    const batch = core.require('batch', batchId);
    if (batch.project_id !== target.project_id || batch.plan_id !== target.plan_id)
      throw new Error('EVALUATION_TARGET_MISMATCH');
    const request = {
      ...policy.context(),
      ...evaluationSubject(core, batchId),
      action: 'inspect_customer_data',
      data_classification: classification,
    };
    policy.validate(request, 0);
    const snapshot = evaluationSnapshot(core, batchId);
    // Recheck expiry/revocation after reading and before returning any payload.
    policy.validate(request, 0);
    return { ...snapshot, classification, synthetic: false, authorization_grant_sha256: policy.approvedSha };
  } finally {
    core.close();
  }
}
