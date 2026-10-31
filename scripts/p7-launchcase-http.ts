/** Real loopback REST with a disposable Engine and Mock only; no shared DB. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/app.js';
import { Core } from '../packages/core/service.js';
import { MockProvider } from '../packages/providers/mock/index.js';
const root = await mkdtemp(join(tmpdir(), 'p7-lc-engine-'));
process.env.CREATIVE_API_TOKEN = 'launchcase-isolated-test-token';
const core = new Core(root, new Map([['mock', new MockProvider(join(root, 'mock'))]]));
const { app } = await buildApp(core, true);
try {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const consumer = process.env.CONTRACT_LAUNCHCASE_ROOT;
  if (!consumer) throw new Error('CONTRACT_LAUNCHCASE_ROOT must name the isolated LaunchCase worktree');
  const result = await new Promise<number>((done, reject) => {
    const child = spawn(
      join(consumer, '.venv/bin/python'),
      ['-m', 'pytest', 'tests/test_p7_sku.py', 'tests/test_visuals.py', '-q'],
      {
        cwd: consumer,
        stdio: 'inherit',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          PYTHONPATH: join(consumer, 'src'),
          PYTHONDONTWRITEBYTECODE: '1',
          ALLOW_TEST_LIVE: 'off',
          LAUNCHCASE_TEST_ENGINE_HTTP: '1',
          LAUNCHCASE_TEST_ENGINE_URL: url,
        },
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => done(code ?? 1));
  });
  process.exitCode = result;
  console.log(
    JSON.stringify({
      environment: 'E1',
      provider: 'mock_and_deterministic',
      engine_data_isolated: true,
      paid_calls: 0,
      external_writes: 0,
      events: core.store.events().length,
      assets: core.store
        .list('asset')
        .map((a) => ({
          identity: a.identity,
          sha256: a.sha256,
          provider: a.provider,
          review_status: a.review_status,
        })),
    }),
  );
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
