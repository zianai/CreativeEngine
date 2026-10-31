/** Synthetic grant fixtures test policy only; never represent a real data authorization. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../../packages/core/service.js';
import { MockProvider } from '../../packages/providers/mock/index.js';
import { Worker } from '../../packages/core/worker.js';
import { ValidationRunPolicy, sha } from '../../packages/core/validation.js';
import { authorizedEvaluation, evaluationSubject } from '../../packages/core/evaluation-export.js';

test('P8-T020 evaluation cannot relabel existing data synthetic or borrow a foreign grant', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ce-eval-policy-')),
    root = join(parent, 'data'),
    grantRoot = join(parent, 'grant');
  const core = new Core(root, new Map([['mock', new MockProvider(join(root, 'provider-receipts/mock'))]]));
  let closed = false;
  try {
    const p = core.project({ name: 'SYNTHETIC POLICY TEST' }),
      b = core.brief({
        project_id: p.id,
        workflow: 'product-concept',
        product: { product_id: 'TEST', stage: 'concept' },
        requirements: 'Synthetic',
        variants: 1,
      });
    const plan = core.plan(b.id),
      batch = core.createBatch({ plan_id: plan.id, budget_usd: 0 });
    await new Worker(core).drain();
    const subject = evaluationSubject(core, batch.id),
      context = {
        ...subject,
        run_id: 'test',
        system: 'creative_engine',
        tenant_id: 'synthetic',
        environment: 'live_sandbox',
        dataset_id: 'SYNTHETIC',
        data_classification: 'public',
        provider: 'stub',
        model: 'stub-read',
        domain: 'local.invalid',
      };
    const grant = {
      ...context,
      actor_id: 'SYNTHETIC TEST ACTOR',
      actor_origin: 'operator',
      human_reason: 'Fixture only',
      approved_at_utc: new Date(Date.now() - 10000).toISOString(),
      expires_at_utc: new Date(Date.now() + 60000).toISOString(),
      allow_external_writes: false,
      export_allowed: true,
      data_classifications: ['public'],
      capabilities: {
        inspect_customer_data: {
          provider: 'stub',
          model: 'stub-read',
          domain: 'local.invalid',
          max_requests: 1,
          max_images: 0,
          max_attempts: 1,
          max_usd: 0,
        },
      },
      evaluation_subject: { data_root: root, batch_id: batch.id, project_id: p.id, plan_id: plan.id },
    };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(grantRoot);
    const put = (name: string, data: unknown) =>
      writeFileSync(join(grantRoot, name), JSON.stringify(data), { mode: 0o600 });
    put('context.json', context);
    put('isolation.json', { ...context, data_root: grantRoot });
    put('grant.json', grant);
    const policy = new ValidationRunPolicy(grantRoot, sha(JSON.stringify(grant)), true);
    assert.throws(() => authorizedEvaluation(policy, root, batch.id, 'synthetic'), /RELABELLED/);
    assert.throws(
      () => authorizedEvaluation(policy, join(parent, 'never-opened'), batch.id, 'public'),
      /TARGET_MISMATCH/,
    );
    assert.throws(() => authorizedEvaluation(policy, root, 'foreign-batch', 'public'), /TARGET_MISMATCH/);
    core.close();
    closed = true;
    const before = sha(readFileSync(join(root, 'creative.sqlite')));
    const snapshot = authorizedEvaluation(policy, root, batch.id, 'public');
    assert.equal(snapshot.batch_id, batch.id);
    assert.equal(snapshot.synthetic, false);
    assert.equal(sha(readFileSync(join(root, 'creative.sqlite'))), before);
    const changed = { ...grant, plan_hash: 'a'.repeat(64) };
    put('grant.json', changed);
    put('context.json', { ...context, plan_hash: changed.plan_hash });
    const changedPolicy = new ValidationRunPolicy(grantRoot, sha(JSON.stringify(changed)), true);
    assert.throws(() => authorizedEvaluation(changedPolicy, root, batch.id, 'public'), /SUBJECT_MISMATCH/);
    writeFileSync(join(grantRoot, 'revoked'), '');
    assert.throws(() => authorizedEvaluation(changedPolicy, root, batch.id, 'public'), /AUTH_REVOKED/);
  } finally {
    if (!closed) core.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
