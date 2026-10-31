/** Fresh CI-safe fault probes: generated geometry only, no legacy/private artifacts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
import { MockProvider } from '../../packages/providers/mock/index.js';
import { ProviderError, type ImageProvider, type ProviderRequest } from '../../packages/providers/types.js';

function fixture(mode = 'normal', variants = 1) {
  const root = mkdtempSync(join(tmpdir(), 'p7-worker-'));
  const mock = new MockProvider(join(root, 'receipts'));
  let calls = 0,
    version = 1;
  const provider: ImageProvider = {
    id: 'test-paid',
    capabilities: () => ({ ...mock.capabilities(), paid: true }),
    configuration: () => ({ version }),
    estimateCost: () => 0.01,
    healthCheck: async () => ({ available: true, live_verified: false }),
    getResult: async () => null,
    generate: async (req: ProviderRequest) => {
      calls++;
      if (mode === 'uncertain' || (mode === 'partial' && calls === 2))
        throw new ProviderError('ACCEPTED_TIMEOUT', 'unknown', { uncertain: true });
      if (mode === '429' && calls === 1)
        throw new ProviderError('RATE_LIMIT', 'explicit rejection', { retryable: true, retryAfterMs: 1 });
      const result = await mock.generate(req);
      return {
        ...result,
        costUsd: mode === 'invalid-usage' ? Number.NaN : 0.01,
        metadata: { ...result.metadata, cost_basis: 'reservation_estimate' },
      };
    },
    edit: async () => {
      throw new Error('not used');
    },
  };
  const core = new Core(root, new Map([[provider.id, provider]]));
  const project = core.project({ name: 'P7 SYNTHETIC ONLY' });
  const brief = core.brief({
    project_id: project.id,
    workflow: 'product-concept',
    product: { product_id: 'SYNTHETIC', stage: 'concept' },
    requirements: 'Synthetic geometric fixture; no product claims',
    provider: provider.id,
    variants,
  });
  const plan = core.plan(brief.id),
    batch = core.createBatch({
      plan_id: plan.id,
      budget_usd: 1,
      authorize_paid: true,
      idempotency_key: 'one',
    });
  return {
    root,
    core,
    provider,
    plan,
    batch,
    calls: () => calls,
    drift: () => {
      version++;
    },
    close: () => {
      core.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('two workers atomically claim one task; cancelled queue never executes', async () => {
  const f = fixture();
  try {
    const a = new Worker(f.core),
      b = new Worker(f.core);
    assert(a.claim());
    assert.equal(b.claim(), undefined);
    assert.equal(f.calls(), 0);
    f.core.controlBatch(f.batch.id, 'cancel');
    await b.recover();
    assert.equal(f.calls(), 0);
  } finally {
    f.close();
  }
});
test('worker death after reservation without receipt reconciles after restart', async () => {
  const f = fixture();
  try {
    const worker = new Worker(f.core);
    const claimed = worker.claim();
    f.core.store.saveTask({ ...claimed, lease_until: 0 });
    await new Worker(f.core).recover();
    assert.equal(f.core.require('task', claimed.id).status, 'reconciling');
    await new Worker(f.core).drain();
    assert.equal(f.calls(), 0);
    assert.equal(f.core.require('batch', f.batch.id).reserved_usd, 0.01);
  } finally {
    f.close();
  }
});
test('accepted timeout and missing usage never repeat or report zero liability', async () => {
  for (const mode of ['uncertain', 'invalid-usage']) {
    const f = fixture(mode);
    try {
      const w = new Worker(f.core);
      await w.drain();
      await new Worker(f.core).drain();
      assert.equal(f.calls(), 1);
      assert.equal(f.core.store.tasks()[0].status, 'reconciling');
      assert.equal(f.core.require('batch', f.batch.id).reserved_usd, 0.01);
      const summary = f.core.batch(f.batch.id).cost_summary;
      assert.equal(summary.charge_status, 'unknown');
      assert.equal(summary.actual_cost_usd, null);
    } finally {
      f.close();
    }
  }
});
test('explicit 429 can retry within old worker ceiling, unlike an accepted timeout', async () => {
  const f = fixture('429');
  try {
    const w = new Worker(f.core);
    const task = w.claim();
    await w.execute(task);
    assert.equal(f.core.store.tasks()[0].status, 'queued');
    f.core.store.saveTask({ ...f.core.store.tasks()[0], next_run: 0 });
    await w.drain();
    assert.equal(f.calls(), 2);
    assert.equal(f.core.store.tasks()[0].status, 'review_pending');
  } finally {
    f.close();
  }
});
test('provider drift fails before execution', async () => {
  const f = fixture();
  try {
    f.drift();
    await new Worker(f.core).drain();
    assert.equal(f.calls(), 0);
    assert.equal(f.core.store.tasks()[0].error.code, 'PROVIDER_CONFIGURATION_CHANGED');
  } finally {
    f.close();
  }
});
test('partial batch has separate successful and reconciling receipts', async () => {
  const f = fixture('partial', 2);
  try {
    await new Worker(f.core, 1).drain();
    assert.equal(f.calls(), 2);
    assert.deepEqual(
      new Set(f.core.store.tasks().map((t) => t.status)),
      new Set(['review_pending', 'reconciling']),
    );
    assert.equal(f.core.store.list('asset').length, 1);
    assert.equal(f.core.batch(f.batch.id).cost_summary.charge_status, 'unknown');
  } finally {
    f.close();
  }
});
test('concept/Mock label, skipped Vision, independent review, and tamper gate', async () => {
  const f = fixture();
  try {
    await new Worker(f.core).drain();
    const asset = f.core.store.list('asset')[0],
      qa = f.core.asset(asset.id).qa;
    assert.equal(asset.identity, 'mock');
    assert.equal(asset.review_status, 'pending');
    assert.equal(qa.vision.status, 'skipped');
    assert(qa.checks.some((c: any) => c.name === 'mock_identity' && c.status === 'warn'));
    assert.equal(f.core.batch(f.batch.id).cost_summary.cost_per_approved_asset, null);
    writeFileSync(asset.path, Buffer.from('tampered'));
    assert.throws(
      () => f.core.review(asset.id, { decision: 'approved', reviewer: 'SYNTHETIC TEST', notes: 'must fail' }),
      /ASSET_TAMPERED/,
    );
  } finally {
    f.close();
  }
});

test('quiesced backup and same-path restore retain assets and unknown receipts', async () => {
  const f = fixture('partial', 2),
    backup = f.root + '-backup';
  let restored: Core | undefined;
  let closed = false;
  try {
    await new Worker(f.core, 1).drain();
    const asset = f.core.store.list('asset')[0];
    const bytes = readFileSync(asset.path);
    f.core.close();
    closed = true;
    cpSync(f.root, backup, { recursive: true });
    rmSync(f.root, { recursive: true });
    cpSync(backup, f.root, { recursive: true });
    restored = new Core(f.root, new Map([[f.provider.id, f.provider]]));
    assert.equal(restored.batch(f.batch.id).cost_summary.charge_status, 'unknown');
    assert.equal(restored.asset(asset.id).sha256, asset.sha256);
    assert.deepEqual(readFileSync(asset.path), bytes);
    await new Worker(restored, 1).drain();
    assert.equal(f.calls(), 2);
  } finally {
    if (restored) restored.close();
    if (!closed) f.core.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
});
