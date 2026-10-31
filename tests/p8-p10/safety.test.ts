/** E1 generated fixtures only. No real provider or human business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
import { MockProvider } from '../../packages/providers/mock/index.js';
import { type ImageProvider } from '../../packages/providers/types.js';

export async function fixture(strict = false) {
  const root = mkdtempSync(join(tmpdir(), 'ce-p8-safe-'));
  const mock = new MockProvider(join(root, 'provider-receipts/mock'));
  const core = new Core(root, new Map([['mock', mock]]));
  const project = core.project({ name: 'SYNTHETIC GEOMETRY — E1 ONLY' });
  let source: any;
  let truth: any;
  if (strict) {
    const data = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#35705b' } })
      .png()
      .toBuffer();
    source = await core.importAsset({
      project_id: project.id,
      filename: 'synthetic.png',
      data_base64: data.toString('base64'),
      kind: 'product_photo',
      authorized: true,
      verified: true,
      sensitive_data_cleared: true,
    });
    truth = core.truth({
      project_id: project.id,
      product_id: 'TEST-SKU',
      version: '1',
      facts: [
        {
          name: 'shape',
          value: 'synthetic square',
          source_asset_id: source.id,
          source_version: '1',
          evidence_status: 'verified',
          confirmed_at: new Date().toISOString(),
          external_allowed: false,
        },
      ],
    });
  }
  const brief = core.brief({
    project_id: project.id,
    workflow: strict ? 'buyer-proposal' : 'product-concept',
    product: {
      product_id: strict ? 'TEST-SKU' : 'TEST-CONCEPT',
      stage: strict ? 'existing_sku' : 'concept',
      ...(truth ? { truth_snapshot_id: truth.id } : {}),
    },
    requirements: 'Synthetic geometry only',
    reference_asset_ids: source ? [source.id] : [],
    variants: 1,
    provider: 'mock',
    delivery_target: 'internal_review',
  });
  const plan = core.plan(brief.id);
  const batch = core.createBatch({ plan_id: plan.id, budget_usd: 0, idempotency_key: 'one' });
  return {
    root,
    core,
    project,
    source,
    truth,
    plan,
    batch,
    close() {
      core.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('P9-T020 source rights revoked after QA blocks both approval and cached export', async () => {
  const f = await fixture(true);
  try {
    await new Worker(f.core).drain();
    const asset = f.core.store.list('asset').find((a) => a.task_id)!;
    const qa = f.core.require('qa', asset.qa_id);
    f.core.store.put('qa', {
      ...qa,
      status: 'pass',
      vision: {
        status: 'completed',
        report: { issues: [], uncertainty: 'low', summary: 'SYNTHETIC PASS used to test rights precedence' },
      },
    });
    f.core.review(asset.id, { decision: 'approved', reviewer: 'SYNTHETIC E1 REVIEWER' });
    const pkg = await f.core.export({ batch_id: f.batch.id });
    f.core.store.put('asset', { ...f.core.require('asset', f.source.id), authorized: false });
    assert.throws(
      () => f.core.review(asset.id, { decision: 'approved', reviewer: 'SYNTHETIC E1 REVIEWER' }),
      /Plan needs corrected|SOURCE_STALE/,
    );
    await assert.rejects(f.core.export({ batch_id: f.batch.id }), /Plan needs corrected|SOURCE_STALE/);
    assert.throws(() => f.core.exportReady(pkg.id), /Plan needs corrected|SOURCE_STALE/);
  } finally {
    f.close();
  }
});

test('P9-T021 cached export rejects modified source, output and package bytes', async () => {
  for (const kind of ['source', 'output', 'package']) {
    const f = await fixture(true);
    try {
      await new Worker(f.core).drain();
      const asset = f.core.store.list('asset').find((a) => a.task_id)!;
      f.core.review(asset.id, { decision: 'approved', reviewer: 'SYNTHETIC E1 REVIEWER' });
      const pkg = await f.core.export({ batch_id: f.batch.id });
      const path =
        kind === 'source'
          ? f.core.require('asset', f.source.id).path
          : kind === 'output'
            ? asset.path
            : f.core.require('export', pkg.id).path;
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('TAMPER')]));
      assert.throws(() => f.core.exportReady(pkg.id), /TAMPERED|hash/i);
    } finally {
      f.close();
    }
  }
});

test('P9-T015 known pre-submission worker death is retryable without charge', async () => {
  const f = await fixture();
  try {
    const mock = f.core.providers.get('mock')!;
    const paid: ImageProvider = {
      ...mock,
      id: 'fault-paid',
      capabilities: () => ({ ...mock.capabilities(), paid: true }),
      configuration: () => ({ version: 1 }),
      healthCheck: async () => ({}),
      estimateCost: () => 0.01,
      getResult: async () => null,
      generate: (req) => mock.generate(req),
      edit: (req) => mock.edit(req),
    };
    f.core.providers.set(paid.id, paid);
    const batch = f.core.createBatch({
      plan_id: f.plan.id,
      provider: paid.id,
      budget_usd: 1,
      authorize_paid: true,
    });
    f.core.controlBatch(f.batch.id, 'cancel');
    const w = new Worker(f.core);
    const task = w.claim();
    assert.equal(task.batch_id, batch.id);
    f.core.store.saveTask({ ...task, lease_until: 0 });
    await new Worker(f.core).recover();
    assert.equal(f.core.require('task', task.id).status, 'queued');
    assert.equal(f.core.require('batch', batch.id).reserved_usd, 0);
  } finally {
    f.close();
  }
});

test('P8-T020 concept-only sources and unauthorized logo cannot become verified SKU', async () => {
  const f = await fixture();
  try {
    await new Worker(f.core).drain();
    const output = f.core.store.list('asset')[0];
    assert.throws(
      () =>
        f.core.truth({
          project_id: f.project.id,
          product_id: 'TEST',
          version: '1',
          facts: [
            {
              name: 'structure',
              value: 'real',
              source_asset_id: output.id,
              source_version: '1',
              evidence_status: 'verified',
              confirmed_at: new Date().toISOString(),
              external_allowed: true,
            },
          ],
        }),
      /original authorized/,
    );
    const b = f.core.brief({
      project_id: f.project.id,
      workflow: 'buyer-proposal',
      product: { product_id: 'TEST', stage: 'existing_sku' },
      reference_asset_ids: [output.id],
      authorized_logo_asset_id: output.id,
      allowed_changes: ['authorized_logo'],
      requirements: 'Untrusted fixture',
      variants: 1,
    });
    assert.equal(f.core.plan(b.id).strategy, 'blocked');
  } finally {
    f.close();
  }
});

test('P8-T021 P9-T019 file QA and skipped Vision do not approve an asset', async () => {
  const f = await fixture();
  try {
    await new Worker(f.core).drain();
    const a = f.core.store.list('asset')[0];
    assert.equal(a.review_status, 'pending');
    assert.equal(f.core.asset(a.id).qa.vision.status, 'skipped');
    await assert.rejects(f.core.export({ batch_id: f.batch.id }), /No approved assets/);
  } finally {
    f.close();
  }
});
test('P9-T016 filesystem failure after a provider response keeps liability and forbids retry', async () => {
  const f = await fixture();
  try {
    const mock = f.core.providers.get('mock')!;
    let calls = 0;
    const paid: ImageProvider = {
      id: 'fault-paid',
      capabilities: () => ({ ...mock.capabilities(), paid: true }),
      configuration: () => ({ synthetic: true }),
      estimateCost: () => 0.01,
      healthCheck: async () => ({}),
      getResult: async () => null,
      generate: async () => {
        calls++;
        return {
          path: join(f.root, 'missing-output.png'),
          provider: 'fault-paid',
          model: 'synthetic',
          costUsd: 0.01,
          mock: true,
        };
      },
      edit: async () => {
        throw new Error('unused');
      },
    };
    f.core.providers.set(paid.id, paid);
    f.core.controlBatch(f.batch.id, 'cancel');
    const batch = f.core.createBatch({
      plan_id: f.plan.id,
      provider: paid.id,
      budget_usd: 1,
      authorize_paid: true,
    });
    await new Worker(f.core).drain();
    await new Worker(f.core).drain();
    assert.equal(calls, 1);
    assert.equal(f.core.store.tasks(batch.id)[0].status, 'reconciling');
    assert.equal(f.core.batch(batch.id).cost_summary.actual_cost_usd, null);
  } finally {
    f.close();
  }
});

test('P9-T021 changed immutable Skill snapshot fails before execution', async () => {
  const f = await fixture();
  try {
    const plan = f.core.require('plan', f.plan.id);
    plan.skill_snapshot.digest = '0'.repeat(64);
    f.core.store.put('plan', plan);
    await new Worker(f.core).drain();
    assert.equal(f.core.store.list('asset').length, 0);
    assert.notEqual(f.core.store.tasks(f.batch.id)[0].status, 'review_pending');
  } finally {
    f.close();
  }
});
