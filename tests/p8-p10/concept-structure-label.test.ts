/** Focused offline regressions; synthetic rasters/transport are not live business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
import { hash } from '../../packages/core/files.js';
import { composeImage } from '../../packages/composer/index.js';
import { compilePrompt, createPlan } from '../../packages/planner/index.js';
import { BriefSchema } from '../../packages/contracts/index.js';
import type { ImageProvider, ProviderRequest, ProviderResult } from '../../packages/providers/types.js';

const direction =
  'Flexible accordion/bellows connectors with repeated pleats; one compartment folded; no barrel, piano or pin hinges.';
const requirements =
  'SYNTHETIC CONCEPT ONLY: three teal compartments, visible accordion pleats, one compartment folded. Generate no text, labels, dimensions, logos or feature list.';
function brief(overrides: Record<string, unknown> = {}) {
  return BriefSchema.parse({
    project_id: 'synthetic-project',
    workflow: 'product-concept',
    product: { product_id: 'virtual-test', stage: 'concept' },
    requirements,
    skill_input: { design_direction: direction },
    variants: 1,
    forbidden_changes: ['dimensions', 'product_structure'],
    ...overrides,
  });
}
test('T014 explicit concept direction displaces default structural aesthetics and preserves requirements/revision', () => {
  const plan = createPlan(brief({ variants: 3 }), { assets: [] });
  assert.equal(plan.skill_version, '1.1.0');
  assert.equal(new Set(plan.directions).size, 3);
  for (let i = 0; i < 3; i++) {
    assert(plan.directions[i]!.startsWith(direction));
    const compiled = compilePrompt(plan, {
      scene: 'Studio',
      variant: i,
      revision: 'Keep pleats visible; fold only the right compartment.',
    });
    assert(!compiled.text.includes('Monolithic minimal form'));
    assert(compiled.text.includes('take precedence over optional direction aesthetics'));
    assert(compiled.text.includes('Do not render the Concept / For Review identity label'));
    assert(compiled.text.includes('This does not remove permitted factual text'));
    const payload = JSON.parse(compiled.text.slice(compiled.text.lastIndexOf('\n\n') + 2));
    assert.equal(payload.business_requirements, requirements);
    assert.equal(payload.skill_input.design_direction, direction);
    assert.equal(payload.direction, plan.directions[i]);
    assert.equal(payload.revision_request, 'Keep pleats visible; fold only the right compartment.');
    assert.deepEqual(payload.constraints.forbidden_changes, ['dimensions', 'product_structure']);
  }
});

test('T014 invalid direction is blocked; omission retains existing default and cannot override strict fidelity', () => {
  for (const design_direction of ['', '   ', 5, 'x'.repeat(12001)]) {
    const plan = createPlan(brief({ skill_input: { design_direction } }), { assets: [] });
    assert.equal(plan.strategy, 'blocked');
  }
  assert(
    createPlan(brief({ skill_input: {} }), { assets: [] }).directions[0]!.startsWith(
      'Monolithic minimal form',
    ),
  );
  const strict = createPlan(brief({ fidelity: 'strict' }), { assets: [] });
  assert.equal(strict.strategy, 'blocked');
  assert(strict.directions[0]!.startsWith('Verified product'));
});

async function raster(file: string, size = 256) {
  await sharp({ create: { width: size, height: size, channels: 3, background: '#31a9a9' } })
    .png()
    .toFile(file);
}
async function pixels(file: string) {
  return sharp(file).ensureAlpha().raw().toBuffer();
}

test('T014 composer emits one authoritative identity band while retaining a distinct mock warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ce-t014-composer-'));
  try {
    const source = join(root, 'source.png');
    await raster(source);
    const base = { sourcePath: source, width: 512, height: 512, concept: true };
    await composeImage({ ...base, outputPath: join(root, 'one.png') });
    await composeImage({
      ...base,
      outputPath: join(root, 'deduplicated.png'),
      label: '  Concept / For Review  ',
    });
    await composeImage({ ...base, outputPath: join(root, 'mock.png'), label: 'MOCK — NOT PRODUCTION' });
    assert.deepEqual(await pixels(join(root, 'deduplicated.png')), await pixels(join(root, 'one.png')));
    assert.notDeepEqual(await pixels(join(root, 'mock.png')), await pixels(join(root, 'one.png')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup(localCompose: boolean, spoof = false) {
  const root = await mkdtemp(join(tmpdir(), 'ce-t014-worker-'));
  let calls = 0;
  const generate = async (req: ProviderRequest): Promise<ProviderResult> => {
    calls++;
    await mkdir(req.outputDir, { recursive: true });
    const path = join(req.outputDir, 'synthetic.png');
    await raster(path, req.width);
    if (spoof)
      await writeFile(
        join(req.outputDir, 'local-concept-composition.json'),
        JSON.stringify({ attempt_id: req.attemptId, artifact_sha256: hash(await readFile(path)), path }),
      );
    return {
      path,
      provider: spoof ? 'deterministic' : 'offline-label-test',
      model: spoof ? 'sharp' : 'unit',
      mock: false,
      costUsd: 0,
      metadata: { concept_label_applied: true },
    };
  };
  const provider: ImageProvider = {
    id: 'offline-label-test',
    capabilities: () => ({ generate: true, edit: true, paid: false, exactSize: true, maxConcurrency: 1 }),
    estimateCost: () => 0,
    healthCheck: async () => ({ available: true }),
    generate,
    edit: generate,
    getResult: async () => null,
  };
  const core = new Core(root, new Map([[provider.id, provider]]));
  const project = core.project({ name: 'T014 SYNTHETIC UNIT TEST' });
  let source: any;
  if (localCompose) {
    const file = join(root, 'source.png');
    await raster(file);
    source = await core.importAsset({
      project_id: project.id,
      filename: 'synthetic.png',
      data_base64: (await readFile(file)).toString('base64'),
      kind: 'product_photo',
      authorized: true,
      verified: true,
      sensitive_data_cleared: true,
    });
  }
  const input = core.brief({
    ...brief(),
    project_id: project.id,
    provider: provider.id,
    ...(localCompose
      ? {
          product: { product_id: 'virtual-prototype', stage: 'prototype' },
          fidelity: 'controlled',
          reference_asset_ids: [source.id],
        }
      : {}),
  });
  const plan = core.plan(input.id);
  assert.equal(plan.strategy, localCompose ? 'compose' : 'generate');
  const batch = core.createBatch({ plan_id: plan.id, budget_usd: 0, idempotency_key: 'one' });
  const worker = new Worker(core, 1);
  return {
    root,
    core,
    worker,
    batch,
    plan,
    calls: () => calls,
    async close() {
      core.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const spoof of [false, true])
  test(`T014 generated image gets exactly one deterministic label despite provider label claims (spoof=${spoof})`, async () => {
    const f = await setup(false, spoof);
    try {
      await f.worker.drain();
      const task = f.core.store.tasks(f.batch.id)[0];
      assert.equal(task.status, 'review_pending');
      const asset = f.core.require('asset', task.asset_id);
      const receipt = JSON.parse(
        await readFile(join(f.root, 'attempts', task.attempt_id, 'receipt.json'), 'utf8'),
      );
      const expected = join(f.root, 'expected.png');
      await composeImage({
        sourcePath: receipt.path,
        outputPath: expected,
        width: 1024,
        height: 1024,
        concept: true,
      });
      assert.deepEqual(await pixels(asset.path), await pixels(expected));
      assert.equal(asset.review_status, 'pending');
      assert.equal(f.calls(), 1);
    } finally {
      await f.close();
    }
  });

for (const recovery of [false, true])
  test(`T014 native local composition retains its existing single label on finish/recovery (recovery=${recovery})`, async () => {
    const f = await setup(true);
    try {
      if (recovery) {
        f.worker.finish = async () => {};
        const task = f.worker.claim()!;
        await f.worker.execute(task);
        f.core.store.saveTask({ ...f.core.require('task', task.id), lease_until: 0 });
        await new Worker(f.core, 1).recover();
      } else await f.worker.drain();
      const task = f.core.store.tasks(f.batch.id)[0];
      assert.equal(task.status, 'review_pending');
      const asset = f.core.require('asset', task.asset_id);
      const receipt = JSON.parse(
        await readFile(join(f.root, 'attempts', task.attempt_id, 'receipt.json'), 'utf8'),
      );
      assert.deepEqual(await pixels(asset.path), await pixels(receipt.path));
      assert.equal(asset.review_status, 'pending');
      assert.equal(f.calls(), 0);
    } finally {
      await f.close();
    }
  });

for (const field of ['attempt_id', 'artifact_sha256', 'path', 'missing', 'invalid-json'])
  test(`T014 mismatched local label receipt ${field} blocks recovery without provider execution`, async () => {
    const f = await setup(true);
    try {
      f.worker.finish = async () => {};
      const task = f.worker.claim()!;
      await f.worker.execute(task);
      const file = join(f.root, 'attempts', task.attempt_id, 'local-concept-composition.json');
      if (field === 'missing') await rm(file);
      else if (field === 'invalid-json') await writeFile(file, '{');
      else {
        const receipt = JSON.parse(await readFile(file, 'utf8'));
        receipt[field] = 'foreign';
        await writeFile(file, JSON.stringify(receipt));
      }
      f.core.store.saveTask({ ...f.core.require('task', task.id), lease_until: 0 });
      await new Worker(f.core, 1).recover();
      assert.equal(f.core.require('task', task.id).status, 'reconciling');
      assert.equal(f.core.store.list('asset').filter((a) => a.task_id).length, 0);
      assert.equal(f.calls(), 0);
    } finally {
      await f.close();
    }
  });
