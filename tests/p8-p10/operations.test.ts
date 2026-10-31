import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
import { MockProvider } from '../../packages/providers/mock/index.js';
import { backupWorkspace, restoreWorkspace } from '../../packages/core/operations.js';
import { evaluationSnapshot } from '../../packages/core/evaluation.js';
test('P10-T006 backup restores new directory with exact assets and no repeat provider call', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ce-restore-')),
    root = join(parent, 'old'),
    snapshot = join(parent, 'backup'),
    target = join(parent, 'new');
  let core: Core | undefined;
  try {
    core = new Core(root, new Map([['mock', new MockProvider(join(root, 'provider-receipts/mock'))]]));
    const p = core.project({ name: 'SYNTHETIC RESTORE' });
    const b = core.brief({
      project_id: p.id,
      workflow: 'product-concept',
      product: { product_id: 'TEST', stage: 'concept' },
      requirements: 'Synthetic backup fixture',
      variants: 1,
    });
    const plan = core.plan(b.id),
      batch = core.createBatch({ plan_id: plan.id, budget_usd: 0 });
    await new Worker(core).drain();
    const asset = core.store.list('asset')[0];
    core.review(asset.id, { decision: 'approved', reviewer: 'SYNTHETIC E1' });
    const pkg = await core.export({ batch_id: batch.id });
    const expected = readFileSync(asset.path);
    const evalBefore = evaluationSnapshot(core, batch.id);
    core.close();
    core = undefined;
    await backupWorkspace(root, snapshot);
    const result = restoreWorkspace(snapshot, target);
    assert.equal(result.status, 'restored');
    core = new Core(target, new Map([['mock', new MockProvider(join(target, 'provider-receipts/mock'))]]));
    const restored = core.require('asset', asset.id);
    assert(restored.path.startsWith(target));
    assert.deepEqual(readFileSync(restored.path), expected);
    assert.equal(core.exportReady(pkg.id).manifest.assets[0].sha256, asset.sha256);
    await new Worker(core).drain();
    assert.equal(core.store.list('attempt').length, 1);
    assert.deepEqual(evaluationSnapshot(core, batch.id), evalBefore);
    assert.equal(core.store.db.prepare('SELECT count(*) n FROM migrations').get()?.n, 1);
  } finally {
    core?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
test('P10-T010 snapshot corruption fails closed', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ce-backup-deny-')),
    root = join(parent, 'old'),
    snapshot = join(parent, 'backup');
  const core = new Core(root, new Map());
  try {
    core.project({ name: 'SYNTHETIC' });
    await backupWorkspace(root, snapshot);
    const manifest = JSON.parse(readFileSync(join(snapshot, 'backup-manifest.json'), 'utf8'));
    manifest.files[0].name = '../escape';
    writeFileSync(join(snapshot, 'backup-manifest.json'), JSON.stringify(manifest));
    assert.throws(() => restoreWorkspace(snapshot, join(parent, 'new')), /UNSAFE_BACKUP_PATH/);
  } finally {
    core.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
test('P10-T006 active queue cannot be snapshotted', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ce-live-backup-')),
    root = join(parent, 'old'),
    core = new Core(root, new Map([['mock', new MockProvider(join(root, 'provider-receipts/mock'))]]));
  try {
    const project = core.project({ name: 'SYNTHETIC' }),
      brief = core.brief({
        project_id: project.id,
        workflow: 'product-concept',
        product: { product_id: 'TEST', stage: 'concept' },
        requirements: 'Synthetic backup fixture',
        variants: 1,
      });
    core.createBatch({ plan_id: core.plan(brief.id).id, budget_usd: 0 });
    await assert.rejects(backupWorkspace(root, join(parent, 'backup')), /STOP_WRITERS/);
  } finally {
    core.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('P10-T006 new-directory restore preserves unknown paid receipt liability without resubmit', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ce-restore-unknown-')),
    root = join(parent, 'old'),
    snapshot = join(parent, 'snapshot'),
    target = join(parent, 'restored');
  const { spawnSync } = await import('node:child_process');
  const run = (path: string, mode: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'tests/p8-p10/crash-child.ts', path, mode], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ALLOW_TEST_LIVE: 'off',
      },
      encoding: 'utf8',
      timeout: 20000,
    });
  try {
    assert.equal(run(root, 'submitted').status, 86);
    assert.equal(run(root, 'recover').status, 0);
    await backupWorkspace(root, snapshot);
    restoreWorkspace(snapshot, target);
    assert.equal(run(target, 'recover').status, 0);
    const core = new Core(target, new Map());
    try {
      const task = core.store.tasks()[0];
      assert.equal(task.status, 'reconciling');
      assert.equal(core.batch(task.batch_id).cost_summary.actual_cost_usd, null);
      assert(core.batch(task.batch_id).cost_summary.unknown_liability_usd > 0);
      assert.equal(readFileSync(join(target, 'calls.txt'), 'utf8').trim(), 'image');
    } finally {
      core.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
