/** Start the real HTTP service with ONLY a zero-cost provider in a disposable DB. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/app.js';
import { Core } from '../packages/core/service.js';
import { MockProvider } from '../packages/providers/mock/index.js';
import type { ImageProvider } from '../packages/providers/types.js';

const root = await mkdtemp(join(tmpdir(), 'creative-contract-'));
process.env.CREATIVE_API_TOKEN = 'visual-contract-test-only';
// Even a developer shell with real keys cannot reach a paid provider in this test.
const mock = new MockProvider(join(root, 'mock'));
let paidCalls = 0;
const forbidden = async (): Promise<never> => {
  paidCalls++;
  throw new Error('Contract attempted an unauthorized paid operation');
};
const paid: ImageProvider = {
  id: 'contract-paid',
  capabilities: () => ({ ...mock.capabilities(), paid: true }),
  configuration: () => ({ mode: 'non-executing-contract-sentinel' }),
  estimateCost: () => 0.05,
  healthCheck: async () => ({ available: true, live_verified: false }),
  generate: forbidden,
  edit: forbidden,
  getResult: async () => null,
};
const core = new Core(
  root,
  new Map<string, ImageProvider>([
    ['mock', mock],
    [paid.id, paid],
  ]),
);
const { app } = await buildApp(core, true);
try {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const run = (script: string, pythonPath?: string) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(process.env.PYTHON ?? 'python3', [script, '--url', url], {
        stdio: 'inherit',
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PYTHONPATH: pythonPath },
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  process.exitCode = await run('contracts/visual-task/verify.py');
  const consumerRoot = process.env.CONTRACT_CONSUMER_ROOT;
  if (process.exitCode === 0 && consumerRoot)
    process.exitCode = await run(
      join(consumerRoot, 'contracts/visual-task/live_consumer.py'),
      join(consumerRoot, 'src'),
    );
  if (paidCalls !== 0) throw new Error('Paid sentinel was invoked');
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
