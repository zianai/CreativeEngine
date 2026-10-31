/** Tests a synthetic operator record, never contacts a provider or authorizes real data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core, dimensions } from '../../packages/core/service.js';
import { OpenAIImageProvider } from '../../packages/providers/openai-image/index.js';
import { evaluationSubject } from '../../packages/core/evaluation-export.js';
import { sha } from '../../packages/core/validation.js';
test('P9-CE-01 real Worker entrypoint denies no grant, binds preflight and never runs without credential', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ce-paid-preflight-')),
    root = join(parent, 'data'),
    records = join(parent, 'operator');
  mkdirSync(records);
  const provider = new OpenAIImageProvider({ stateDir: join(root, 'provider-receipts/openai') });
  const core = new Core(root, new Map([['openai', provider]]));
  try {
    const project = core.project({ name: 'SYNTHETIC E1 HARNESS' }),
      brief = core.brief({
        project_id: project.id,
        workflow: 'product-concept',
        product: { product_id: 'TEST', stage: 'concept' },
        requirements: 'Synthetic local preflight only',
        variants: 1,
        provider: 'openai',
      }),
      plan = core.plan(brief.id),
      batch = core.createBatch({ plan_id: plan.id, budget_usd: 1, authorize_paid: true }),
      task = core.store.tasks(batch.id)[0];
    const subject = evaluationSubject(core, batch.id),
      context = {
        ...subject,
        run_id: 'synthetic-fixture',
        system: 'creative_engine',
        tenant_id: 'synthetic',
        environment: 'live_sandbox',
        dataset_id: 'SYNTHETIC',
        data_classification: 'synthetic',
        provider: 'openai',
        model: provider.model,
        domain: 'api.openai.com',
        provider_config_hash: sha(JSON.stringify(provider.configuration())),
        input_hash: sha(
          JSON.stringify({
            prompt: task.prompt.text,
            ...dimensions(plan.aspect_ratio),
            refs: [],
            mode: 'generate',
          }),
        ),
      };
    const cap = {
      provider: 'openai',
      model: provider.model,
      domain: 'api.openai.com',
      max_requests: 1,
      max_images: 1,
      max_attempts: 1,
      max_usd: 1,
    };
    const grant = {
      ...context,
      actor_id: 'SYNTHETIC TEST ACTOR',
      actor_origin: 'operator',
      human_reason: 'E1 fixture only',
      approved_at_utc: new Date(Date.now() - 10000).toISOString(),
      expires_at_utc: new Date(Date.now() + 120000).toISOString(),
      allow_external_writes: false,
      export_allowed: true,
      data_classifications: ['synthetic'],
      capabilities: { generate_image: cap, inspect_customer_data: cap },
      worker_subject: {
        data_root: root,
        batch_id: batch.id,
        project_id: project.id,
        plan_id: plan.id,
        task_id: task.id,
      },
    };
    for (const [name, data] of Object.entries({
      'grant.json': grant,
      'context.json': context,
      'isolation.json': { ...context, data_root: records },
    }))
      writeFileSync(join(records, name), JSON.stringify(data), { mode: 0o600 });
    const base = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ALLOW_TEST_LIVE: 'off',
    };
    const run = (mode: string, env: any = base) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'scripts/p9-paid-worker.ts', mode, root, batch.id], {
        env,
        encoding: 'utf8',
        timeout: 60000,
      });
    const denied = run('--preflight');
    assert.notEqual(denied.status, 0);
    assert(denied.stderr.includes('BLOCKED_EXTERNAL'));
    const syntheticEnv = {
      ...base,
      ALLOW_TEST_LIVE: 'on',
      CREATIVE_ENGINE_P7_ROOT: records,
      CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256: sha(JSON.stringify(grant)),
    };
    const allowed = run('--preflight', syntheticEnv);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).executed, false);
    const execute = run('--execute-once', syntheticEnv);
    assert.notEqual(execute.status, 0);
    assert(execute.stderr.includes('credential absent'));
    assert.equal(core.store.list('attempt').length, 0);
  } finally {
    core.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
