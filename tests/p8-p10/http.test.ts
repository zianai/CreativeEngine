import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../../packages/core/service.js';
import { MockProvider } from '../../packages/providers/mock/index.js';
import { buildApp } from '../../apps/server/app.js';
async function server(limit = 120) {
  process.env.CREATIVE_API_TOKEN = 'E1-LOCAL-ONLY';
  process.env.CREATIVE_WRITE_RATE_LIMIT = String(limit);
  const root = mkdtempSync(join(tmpdir(), 'ce-http-'));
  const core = new Core(root, new Map([['mock', new MockProvider(join(root, 'provider-receipts/mock'))]]));
  const { app, worker } = await buildApp(core, false);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    core,
    app,
    worker,
    url,
    async close() {
      await app.close();
      rmSync(root, { recursive: true, force: true });
      delete process.env.CREATIVE_WRITE_RATE_LIMIT;
      delete process.env.CREATIVE_API_TOKEN;
    },
  };
}
const headers = {
  authorization: 'Bearer E1-LOCAL-ONLY',
  'X-API-Version': '1.0.0',
  'content-type': 'application/json',
};
test('P10-T002 missing token/config, origin, host and version reject protected data', async () => {
  const f = await server();
  try {
    assert.equal((await fetch(f.url + '/v1/assets')).status, 401);
    assert.equal(
      (await fetch(f.url + '/v1/assets', { headers: { ...headers, Origin: 'https://evil.invalid' } })).status,
      403,
    );
    assert.equal(
      (await f.app.inject({ url: '/v1/assets', headers: { ...headers, host: 'evil.invalid' } })).statusCode,
      403,
    );
    const unsupported = await fetch(f.url + '/v1/assets', {
      headers: { ...headers, 'X-API-Version': '9.0.0' },
    });
    assert.equal(unsupported.status, 409);
    assert.equal(((await unsupported.json()) as any).error.code, 'UNSUPPORTED_API_VERSION');
    delete process.env.CREATIVE_API_TOKEN;
    assert.equal((await fetch(f.url + '/v1/assets', { headers })).status, 503);
  } finally {
    await f.close();
  }
});
test('P9-T029 P10-T003 unsafe uploads and error messages never disclose supplied secrets', async () => {
  const f = await server();
  try {
    const project = f.core.project({ name: 'SYNTHETIC' });
    const secret = 'SYNTHETIC_SECRET_CANARY';
    for (const payload of [
      {
        project_id: project.id,
        filename: '../../' + secret,
        data_base64: 'AAAA',
        kind: 'product_photo',
        authorized: true,
        verified: true,
        sensitive_data_cleared: true,
      },
      {
        project_id: project.id,
        filename: 'fake.png',
        data_base64: Buffer.from('<svg>' + secret + '</svg>').toString('base64'),
        kind: 'product_photo',
        authorized: true,
        verified: true,
        sensitive_data_cleared: true,
      },
    ]) {
      const r = await fetch(f.url + '/v1/assets/import', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(r.status, 400);
      assert(!(await r.text()).includes(secret));
    }
    const longKey = secret.repeat(10);
    const invalid = await fetch(f.url + '/v1/briefs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: project.id,
        workflow: 'product-concept',
        product: { product_id: 'TEST', stage: 'concept' },
        requirements: 'synthetic',
        skill_input: { [longKey]: 1 },
      }),
    });
    assert.equal(invalid.status, 400);
    assert(!(await invalid.text()).includes(secret));
    const missing = await fetch(f.url + '/v1/assets/' + secret, { headers });
    assert.equal(missing.status, 404);
    assert(!(await missing.text()).includes(secret));
    assert.equal(f.core.store.list('asset').length, 0);
  } finally {
    await f.close();
  }
});
test('P10-T009 SSE resume returns durable later events; repeated write idempotency does not duplicate jobs', async () => {
  const f = await server();
  try {
    const p = f.core.project({ name: 'SYNTHETIC SSE' });
    const before = f.core.store.event('fixture.one', p.id);
    const after = f.core.store.event('fixture.two', p.id);
    const controller = new AbortController();
    const r = await fetch(f.url + '/v1/events', {
      headers: { ...headers, 'Last-Event-ID': String(before.seq) },
      signal: controller.signal,
    });
    const reader = r.body!.getReader();
    const chunk = await reader.read();
    const body = new TextDecoder().decode(chunk.value);
    assert(body.includes('fixture.two'));
    assert(!body.includes('fixture.one'));
    controller.abort();
    await reader.cancel().catch(() => {});
    const b = f.core.brief({
      project_id: p.id,
      workflow: 'product-concept',
      product: { product_id: 'TEST', stage: 'concept' },
      requirements: 'SYNTHETIC',
      variants: 1,
    });
    const plan = f.core.plan(b.id);
    const body2 = JSON.stringify({ plan_id: plan.id, budget_usd: 0 });
    const first = await (
      await fetch(f.url + '/v1/batches', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': 'same' },
        body: body2,
      })
    ).json();
    const second = await (
      await fetch(f.url + '/v1/batches', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': 'same' },
        body: body2,
      })
    ).json();
    assert.equal((first as any).id, (second as any).id);
    assert.equal(f.core.store.tasks().length, 1);
    await f.worker.drain();
    assert.equal((await fetch(f.url + '/v1/operations/status', { headers })).status, 200);
  } finally {
    await f.close();
  }
});
test('P9-OPS-01 bounded local writes and measured HTTP read latency', async () => {
  const f = await server(2);
  try {
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await fetch(f.url + '/v1/projects', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'SYNTHETIC ' + i }),
          })
        ).status,
        201,
      );
    assert.equal(
      (
        await fetch(f.url + '/v1/projects', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'SYNTHETIC rejected' }),
        })
      ).status,
      429,
    );
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      assert.equal((await fetch(f.url + '/v1/operations/status', { headers })).status, 200);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        scope: 'local_synthetic_30_sequential_reads_not_SLA',
        median_ms: samples[15],
        p95_ms: samples[28],
      }),
    );
  } finally {
    await f.close();
  }
});
test('P10-T002 local session is HttpOnly, expires on token rotation and rejects cross-port browser origin', async () => {
  const f = await server();
  try {
    const response = await fetch(f.url + '/v1/session', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!;
    assert(cookie.includes('HttpOnly'));
    assert(cookie.includes('SameSite=Strict'));
    assert(!cookie.includes('E1-LOCAL-ONLY'));
    const sessionHeaders = { Cookie: cookie.split(';')[0] };
    assert.equal((await fetch(f.url + '/v1/assets', { headers: sessionHeaders })).status, 200);
    assert.equal(
      (
        await fetch(f.url + '/v1/projects', {
          method: 'POST',
          headers: { ...sessionHeaders, Origin: 'http://127.0.0.1:1', 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'injected' }),
        })
      ).status,
      403,
    );
    process.env.CREATIVE_API_TOKEN = 'ROTATED-SYNTHETIC';
    assert.equal((await fetch(f.url + '/v1/assets', { headers: sessionHeaders })).status, 401);
  } finally {
    await f.close();
  }
});
