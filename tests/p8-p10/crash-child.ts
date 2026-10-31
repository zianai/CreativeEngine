/** Independent process crash points. All pixels/costs/provider responses are synthetic. */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
import { MockProvider } from '../../packages/providers/mock/index.js';
import type { ImageProvider } from '../../packages/providers/types.js';
const [root, mode] = process.argv.slice(2);
mkdirSync(root, { recursive: true });
const mock = new MockProvider(join(root, 'provider-receipts/mock'));
const provider: ImageProvider = {
  id: 'fault-paid',
  capabilities: () => ({ ...mock.capabilities(), paid: true }),
  configuration: () => ({ synthetic: true }),
  estimateCost: () => 0.01,
  healthCheck: async () => ({ available: true }),
  getResult: (id) => mock.getResult(id),
  edit: (r) => mock.edit(r),
  generate: async (req) => {
    appendFileSync(join(root, 'calls.txt'), 'image\n');
    if (mode === 'submitted') process.exit(86);
    const r = await mock.generate(req);
    return { ...r, costUsd: 0.01 };
  },
};
const core = new Core(root, new Map([[provider.id, provider]]));
if (!core.store.list('project').length) {
  const project = core.project({ name: 'SYNTHETIC CRASH ONLY' });
  const b = core.brief({
    project_id: project.id,
    workflow: 'product-concept',
    product: { product_id: 'TEST', stage: 'concept' },
    requirements: 'Synthetic crash fixture',
    variants: 1,
    provider: provider.id,
  });
  const p = core.plan(b.id);
  core.createBatch({ plan_id: p.id, budget_usd: 1, authorize_paid: true });
}
if (mode === 'vision_started') {
  const batch = core.store.list('batch')[0];
  core.store.put('batch', {
    ...batch,
    vision_review: true,
    vision_config: {
      model: 'synthetic',
      reservation_usd: 0.02,
      input_usd_per_million: 1,
      output_usd_per_million: 1,
    },
  });
}
if (mode === 'saved') {
  const put = core.store.put.bind(core.store);
  core.store.put = (kind, data) => {
    if (kind === 'asset' && data.task_id) process.exit(86);
    return put(kind, data);
  };
}
const reviewer = {
  estimateCost: () => 0.02,
  review: async () => {
    appendFileSync(join(root, 'calls.txt'), 'vision\n');
    if (mode === 'vision_started') process.exit(86);
    return { issues: [], uncertainty: 'low' as const, summary: 'SYNTHETIC' };
  },
};
const worker = new Worker(core, 1, 200, () => reviewer);
if (mode === 'claimed') {
  worker.claim();
  process.exit(86);
}
if (mode === 'recover') {
  for (const task of core.store.tasks()) core.store.saveTask({ ...task, lease_until: 0 });
}
await worker.drain();
core.close();
