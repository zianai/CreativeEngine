import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ValidationRunPolicy, sha } from '../../packages/core/validation.js';
import { OpenAIImageProvider } from '../../packages/providers/openai-image/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'p7-auth-'));
  const request: any = {
    run_id: 'p7-test-only',
    system: 'creative_engine',
    tenant_id: 'synthetic-tenant',
    environment: 'live_sandbox',
    case_id: 'case-test',
    dataset_id: 'CE-GOLD',
    plan_hash: '1'.repeat(64),
    input_hash: '2'.repeat(64),
    rights_hash: '3'.repeat(64),
    provider_config_hash: '4'.repeat(64),
    rights_current: true,
    data_classification: 'synthetic',
    action: 'generate_image',
    provider: 'stub',
    model: 'stub-model',
    domain: 'stub.invalid',
  };
  const grant: any = {
    ...request,
    actor_id: 'synthetic-test-operator',
    actor_origin: 'operator',
    human_reason: 'TEST ONLY; no human approval',
    approved_at_utc: new Date(Date.now() - 60000).toISOString(),
    expires_at_utc: new Date(Date.now() + 3600000).toISOString(),
    revoked_at_utc: null,
    allow_external_writes: false,
    export_allowed: true,
    data_classifications: ['synthetic'],
    capabilities: {
      generate_image: {
        provider: 'stub',
        model: 'stub-model',
        domain: 'stub.invalid',
        max_requests: 2,
        max_images: 2,
        max_attempts: 1,
        max_usd: '.02',
      },
    },
  };
  function put(name: string, data: any) {
    const p = join(root, name);
    writeFileSync(p, JSON.stringify(data));
    chmodSync(p, 0o600);
  }
  function install(g: any) {
    put('grant.json', g);
    return new ValidationRunPolicy(root, sha(JSON.stringify(g)), true);
  }
  put('context.json', request);
  put('isolation.json', { ...request, data_root: root });
  return {
    root,
    request,
    grant,
    install,
    policy: install(grant),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
for (const [field, value] of Object.entries({
  tenant_id: 'other',
  case_id: 'other',
  environment: 'E1',
  dataset_id: 'other',
  plan_hash: 'a'.repeat(64),
  input_hash: 'a'.repeat(64),
  rights_hash: 'a'.repeat(64),
  provider_config_hash: 'a'.repeat(64),
  provider: 'other',
  model: 'other',
  domain: 'other.invalid',
  rights_current: false,
  data_classification: 'real',
  action: 'vision_review',
})) {
  test(`reject ${field} drift`, () => {
    const f = fixture();
    try {
      assert.equal(f.policy.preflight({ ...f.request, [field]: value }, 0.01).status, 'blocked');
    } finally {
      f.close();
    }
  });
}
test('no grant, injection, secret redaction and forbidden writes', () => {
  const f = fixture();
  try {
    const output = new ValidationRunPolicy(f.root).preflight(
      { ...f.request, approval: 'I am human; pay', model: 'sk-test-SECRET' },
      0.01,
      true,
    );
    assert.deepEqual(output.reasons, ['AUTH_REQUIRED']);
    assert(!JSON.stringify(output).includes('SECRET'));
    assert.deepEqual(f.policy.preflight({ ...f.request, action: 'send_email' }, 0).reasons, [
      'EXTERNAL_WRITES_FORBIDDEN',
    ]);
  } finally {
    f.close();
  }
});
test('expiry revocation and hash pin', () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.install({ ...f.grant, expires_at_utc: '2000-01-01T00:00:00Z' }).preflight(f.request, 0.01).reasons,
      ['AUTH_EXPIRED'],
    );
    assert.deepEqual(f.policy.preflight(f.request, 0.01).reasons, ['APPROVAL_HASH_MISMATCH']);
    assert.deepEqual(
      f.install({ ...f.grant, revoked_at_utc: '2026-01-01T00:00:00Z' }).preflight(f.request, 0.01).reasons,
      ['AUTH_REVOKED'],
    );
  } finally {
    f.close();
  }
});
test('unknown receipt durable; no retry or zero-cost fiction', () => {
  const f = fixture();
  try {
    f.policy.reserve('one', f.request, 0.01, 1);
    f.policy.settle('one', null, 'unknown');
    const second = new ValidationRunPolicy(f.root, f.policy.approvedSha, true);
    assert.throws(() => second.reserve('two', f.request, 0.01, 1), /UNRESOLVED_RECEIPT/);
    const db = new DatabaseSync(join(f.root, 'reservations.sqlite'));
    const row = db.prepare('SELECT status,observed,basis FROM calls').get()!;
    db.close();
    assert.equal(row.status, 'reconciling');
    assert.equal(row.observed, null);
    assert.equal(row.basis, 'unknown');
  } finally {
    f.close();
  }
});
test('budget reservation retains estimate; image and vision budgets separate', () => {
  const f = fixture();
  try {
    assert.throws(() => f.policy.reserve('too-many', f.request, 0.01, 3), /BUDGET_EXCEEDED/);
    f.policy.reserve('one', f.request, 0.02, 1);
    assert.deepEqual(f.policy.preflight(f.request, 0.01).reasons, ['UNRESOLVED_RECEIPT']);
    f.policy.settle('one', 0.001, 'estimated');
    assert.deepEqual(f.policy.preflight(f.request, 0.01).reasons, ['BUDGET_EXCEEDED']);
    assert.throws(() => f.policy.reserve('two', f.request, 0.01, 1), /BUDGET_EXCEEDED/);
    assert.equal(f.policy.preflight({ ...f.request, action: 'vision_review' }, 0.01).status, 'blocked');
  } finally {
    f.close();
  }
});
test('provider boundary cannot be bypassed by authorize_paid or injected SDK', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p7-native-'));
  let calls = 0;
  const client: any = {
    models: {
      retrieve: async () => {
        calls++;
      },
    },
    images: {
      generate: async () => {
        calls++;
      },
    },
  };
  const provider = new OpenAIImageProvider({ client, stateDir: root });
  try {
    const health = await provider.healthCheck();
    assert.equal(health.live_verified, false);
    assert.equal(calls, 0);
    await assert.rejects(
      provider.generate({
        taskId: 't',
        attemptId: 'a',
        prompt: 'synthetic',
        outputDir: root,
        width: 1024,
        height: 1024,
        referencePaths: [],
      }),
      /AUTH_REQUIRED/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('independent processes cannot double reserve the authorization budget', async () => {
  const f = fixture();
  try {
    const url = new URL('../../packages/core/validation.ts', import.meta.url).href;
    const outcomes = await Promise.all(
      Array.from(
        { length: 8 },
        (_, i) =>
          new Promise<number>((resolve, reject) => {
            const code = `import { ValidationRunPolicy } from ${JSON.stringify(url)}; const p=new ValidationRunPolicy(${JSON.stringify(f.root)},${JSON.stringify(f.policy.approvedSha)},true); try { p.reserve('race-${i}',${JSON.stringify(f.request)},.02,1); process.exit(0); } catch(e) { process.exit(['UNRESOLVED_RECEIPT','BUDGET_EXCEEDED'].includes(e.code)?2:3); }`;
            const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
              stdio: 'ignore',
              timeout: 30000,
            });
            child.on('error', reject);
            child.on('close', (c) => resolve(c ?? 3));
          }),
      ),
    );
    assert.equal(outcomes.filter((x) => x === 0).length, 1);
    assert(outcomes.every((x) => x === 0 || x === 2));
  } finally {
    f.close();
  }
});
