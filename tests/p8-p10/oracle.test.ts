/** Offline protocol/authorization tests: synthetic MCP responses are never live acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  OracleProvider,
  oracleImagePrompt,
  oracleAspectRatio,
} from '../../packages/providers/oracle/index.js';
import { sha } from '../../packages/core/validation.js';
import { DatabaseSync } from 'node:sqlite';
async function fixture(
  response:
    | 'complete'
    | 'timeout'
    | 'running'
    | 'wrong-path'
    | 'revoked'
    | 'config-drift'
    | 'mutated-reference' = 'complete',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oracle-offline-'))),
    generated = join(root, 'generated');
  await mkdir(generated);
  const runtime = join(root, 'runtime.js'),
    reference = join(root, 'reference.png');
  await writeFile(runtime, 'version-one');
  await sharp({ create: { width: 256, height: 256, channels: 3, background: '#fff' } })
    .png()
    .toFile(reference);
  const referencePaths = response === 'mutated-reference' ? [reference] : [];
  let calls = 0,
    probes = 0;
  const provider = new OracleProvider({
    generatedRoot: generated,
    runtimeFiles: [runtime],
    stateDir: join(root, 'receipts'),
    connection: {
      async listTools() {
        probes++;
        if (response === 'revoked') await writeFile(join(root, 'revoked'), 'closed');
        if (response === 'config-drift') await writeFile(runtime, 'version-two');
        if (response === 'mutated-reference')
          await sharp({ create: { width: 256, height: 256, channels: 3, background: '#000' } })
            .png()
            .toFile(reference);
        return {
          tools: [
            {
              name: 'chatgpt_image',
              inputSchema: { properties: { prompt: {}, files: {}, aspectRatio: {} } },
            },
          ],
        };
      },
      async callTool({ arguments: args }) {
        calls++;
        assert(String(args.prompt).startsWith('Generate exactly one NEW image FROM SCRATCH'));
        assert.equal(args.browserModelStrategy, 'current');
        assert.equal(args.browserArchive, 'never');
        assert.equal(args.aspectRatio, '1:1');
        if (response === 'timeout') throw Error('simulated ambiguous timeout');
        const image = response === 'wrong-path' ? join(generated, 'stale.png') : String(args.outputPath);
        await sharp({ create: { width: 256, height: 256, channels: 3, background: '#06a' } })
          .png()
          .toFile(image);
        return {
          structuredContent: {
            status: response === 'running' ? 'running' : 'completed',
            sessionId: 'synthetic-session',
            images: [{ path: image }],
          },
        };
      },
    },
  });
  const req = {
    taskId: 'test-task',
    attemptId: 'test-attempt',
    prompt: 'SYNTHETIC TEST ONLY',
    outputDir: join(root, 'output'),
    width: 256,
    height: 256,
    referencePaths,
  };
  const context = {
    run_id: 'oracle-unit',
    system: 'creative_engine',
    tenant_id: 'virtual',
    environment: 'live_sandbox',
    case_id: 'virtual-case',
    dataset_id: 'virtual-data',
    plan_hash: '1'.repeat(64),
    rights_hash: '2'.repeat(64),
    rights_current: true,
    data_classification: 'synthetic',
    provider: 'oracle',
    model: provider.model,
    domain: 'chatgpt.com',
    input_hash: sha(
      JSON.stringify({
        prompt: oracleImagePrompt(req.prompt, false, referencePaths.length > 0),
        width: req.width,
        height: req.height,
        refs: await Promise.all(referencePaths.map(async (f) => sha(await readFile(f)))),
        mode: 'generate',
      }),
    ),
    provider_config_hash: sha(JSON.stringify(provider.configuration())),
  };
  const grant = {
    ...context,
    actor_id: 'synthetic-unit-operator',
    actor_origin: 'operator',
    human_reason: 'Offline unit test, not business approval',
    approved_at_utc: new Date(Date.now() - 60000).toISOString(),
    expires_at_utc: new Date(Date.now() + 60000).toISOString(),
    allow_external_writes: false,
    export_allowed: true,
    data_classifications: ['synthetic'],
    capabilities: {
      generate_image: {
        provider: 'oracle',
        model: provider.model,
        domain: 'chatgpt.com',
        max_requests: 1,
        max_images: 1,
        max_attempts: 1,
        max_usd: 0.25,
      },
    },
  };
  for (const [name, value] of Object.entries({
    'context.json': context,
    'grant.json': grant,
    'isolation.json': { ...context, data_root: root },
  }))
    await writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 });
  const keys = ['ALLOW_TEST_LIVE', 'CREATIVE_ENGINE_P7_ROOT', 'CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.ALLOW_TEST_LIVE = 'on';
  process.env.CREATIVE_ENGINE_P7_ROOT = root;
  process.env.CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256 = sha(JSON.stringify(grant));
  return {
    root,
    provider,
    req,
    calls: () => calls,
    probes: () => probes,
    async close() {
      await provider.close();
      for (const k of keys) {
        if (old[k] === undefined) delete process.env[k];
        else process.env[k] = old[k];
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('Oracle blocks direct external calls without a pinned grant, and prompt drift before MCP', async () => {
  const f = await fixture();
  try {
    delete process.env.CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256;
    await assert.rejects(f.provider.generate(f.req), /AUTH_REQUIRED/);
    assert.equal(f.calls(), 0);
    assert.equal(f.probes(), 0);
    process.env.CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256 = sha(await readFile(join(f.root, 'grant.json')));
    await assert.rejects(f.provider.generate({ ...f.req, prompt: 'different input' }), /SUBJECT_MISMATCH/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});
test('Oracle completed receipt replays without new generation; changed input cannot reuse attempt', async () => {
  const f = await fixture();
  try {
    const r = await f.provider.generate(f.req);
    assert.equal(r.mock, false);
    assert.equal(r.model, 'oracle-browser-current-unverified');
    assert.equal(r.metadata?.human_approval, false);
    assert.equal(r.metadata?.actual_subscription_cost_usd, null);
    await writeFile(join(f.root, 'revoked'), 'closed');
    assert.deepEqual(await f.provider.generate(f.req), await f.provider.getResult(f.req.attemptId));
    assert.equal(f.calls(), 1);
    await assert.rejects(f.provider.generate({ ...f.req, prompt: 'different' }), /different request/);
  } finally {
    await f.close();
  }
});
for (const mode of ['timeout', 'running', 'wrong-path'] as const)
  test(`Oracle ${mode} stays uncertain and cannot resubmit`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.provider.generate(f.req));
      assert.equal(f.calls(), 1);
      const db = new DatabaseSync(join(f.root, 'reservations.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT status FROM calls').get()?.status, 'reconciling');
      } finally {
        db.close();
      }
      await assert.rejects(f.provider.generate(f.req), /ALREADY_RESERVED_RECONCILE/);
      assert.equal(f.calls(), 1);
    } finally {
      await f.close();
    }
  });

for (const mode of ['revoked', 'config-drift', 'mutated-reference'] as const)
  test(`Oracle ${mode} during probe prevents submission`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.provider.generate(f.req));
      assert.equal(f.calls(), 0);
      assert.equal(f.probes(), 1);
    } finally {
      await f.close();
    }
  });

test('Oracle rejects a preexisting output before submitting', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'generated', `${f.req.attemptId}.png`), 'preexisting');
    await assert.rejects(f.provider.generate(f.req), /Output already exists/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});
test('Oracle warmed connection cannot execute a newly authorized transport configuration', async () => {
  const f = await fixture();
  try {
    await f.provider.healthCheck();
    await writeFile(join(f.root, 'runtime.js'), 'new authorized runtime');
    const grant = JSON.parse(await readFile(join(f.root, 'grant.json'), 'utf8'));
    grant.provider_config_hash = sha(JSON.stringify(f.provider.configuration()));
    await writeFile(join(f.root, 'grant.json'), JSON.stringify(grant));
    const context = JSON.parse(await readFile(join(f.root, 'context.json'), 'utf8'));
    context.provider_config_hash = grant.provider_config_hash;
    await writeFile(join(f.root, 'context.json'), JSON.stringify(context));
    process.env.CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256 = sha(JSON.stringify(grant));
    await assert.rejects(f.provider.generate(f.req), /earlier configuration/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});

test('Oracle aspect ratio uses ratio units rather than pixel counts', () => {
  assert.equal(oracleAspectRatio(1024, 1024), '1:1');
  assert.equal(oracleAspectRatio(1024, 1536), '2:3');
  assert.equal(oracleAspectRatio(1920, 1080), '16:9');
});
