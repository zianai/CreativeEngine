/** Frozen LaunchCase consumer shape exercised against real loopback CE HTTP. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../packages/core/service.js';
import { MockProvider } from '../packages/providers/mock/index.js';
import { buildApp } from '../apps/server/app.js';
import { hash } from '../packages/core/files.js';
const directory = 'contracts/launchcase/1.0.0';
const expected = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').split(' ')[0];
const raw = readFileSync(join(directory, 'fixtures.json'));
assert.equal(hash(raw), expected);
const fixture = JSON.parse(raw.toString());
function shape(value: any, reference: any) {
  assert(value !== null && value !== undefined);
  if (Array.isArray(reference)) {
    assert(Array.isArray(value));
    return;
  }
  if (reference && typeof reference === 'object') {
    for (const key of Object.keys(reference)) shape(value[key], reference[key]);
    return;
  }
  assert.equal(typeof value, typeof reference);
}
function batch(value: any) {
  shape(value, fixture.batch);
  assert.equal(typeof value.cost_usd, 'number');
  assert(Number.isFinite(value.cost_usd) && value.cost_usd >= 0);
}
function asset(value: any) {
  shape(value, fixture.asset);
  assert(['pass', 'warn', 'block'].includes(value.qa.status));
  assert(['completed', 'skipped', 'failed', 'unavailable'].includes(value.qa.vision.status));
  assert(/^[a-f0-9]{64}$/.test(value.sha256));
}
batch(fixture.batch);
asset(fixture.asset);
batch({ ...fixture.batch, optional_future_field: true });
assert.throws(() => batch({ ...fixture.batch, cost_usd: '0 CNY' }));
assert.throws(() => asset({ ...fixture.asset, qa: undefined }));
process.env.CREATIVE_API_TOKEN = 'CE-LC-SYNTHETIC-CONTRACT';
const root = mkdtempSync(join(tmpdir(), 'ce-lc-contract-'));
const core = new Core(root, new Map([['mock', new MockProvider(join(root, 'provider-receipts/mock'))]]));
const { app, worker } = await buildApp(core, false);
try {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = {
    authorization: 'Bearer CE-LC-SYNTHETIC-CONTRACT',
    'X-API-Version': '1.0.0',
    'Content-Type': 'application/json',
  };
  const request = async (path: string, data?: any) => {
    const response = await fetch(url + '/v1' + path, {
      headers,
      method: data ? 'POST' : 'GET',
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    assert(response.ok, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const p = await request('/projects', { name: 'LC FIXED CONTRACT SYNTHETIC' });
  const b = await request('/briefs', {
    project_id: p.id,
    workflow: 'product-concept',
    product: { product_id: 'LC-FIXTURE', stage: 'concept' },
    requirements: 'Synthetic contract geometry',
    variants: 1,
    delivery_target: 'internal_review',
    provider: 'mock',
  });
  const plan = await request(`/briefs/${b.id}/plan`, {});
  const submitted = await request('/batches', {
    plan_id: plan.id,
    budget_usd: 0,
    idempotency_key: 'LC-FIXTURE',
  });
  batch(submitted);
  await worker.drain();
  const result = await request('/batches/' + submitted.id);
  batch(result);
  const output = await request('/assets/' + result.tasks[0].asset_id);
  asset(output);
  assert.equal(output.identity, 'mock');
  assert.equal(output.review_status, 'pending');
  assert.equal(output.qa.vision.status, 'skipped');
  assert.equal(output.project_id, p.id);
  assert.equal(output.batch_id, result.id);
  console.log(
    JSON.stringify({
      contract: 'launchcase/1.0.0',
      fixture_sha256: expected,
      environment: 'E1',
      provider: 'mock',
      result: 'passed',
      paid_calls: 0,
      external_business_writes: 0,
    }),
  );
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
