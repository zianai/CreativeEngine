/** Credential-free E1 service. Launch from a sanitized environment; only loopback listeners. */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Core } from '../packages/core/service.js';
import { MockProvider } from '../packages/providers/mock/index.js';
import { buildApp } from '../apps/server/app.js';
if (!process.env.CREATIVE_DATA_DIR || !process.env.CREATIVE_API_TOKEN)
  throw new Error('CREATIVE_DATA_DIR and a dedicated local CREATIVE_API_TOKEN are required');
if (
  process.env.ALLOW_TEST_LIVE === 'on' ||
  process.env.OPENAI_API_KEY ||
  process.env.CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256
)
  throw new Error('E1_REQUIRES_NO_LIVE_AUTHORITY');
const root = resolve(process.env.CREATIVE_DATA_DIR);
mkdirSync(root, { recursive: true, mode: 0o700 });
const core = new Core(root, new Map([['mock', new MockProvider(resolve(root, 'provider-receipts/mock'))]]));
const { app } = await buildApp(core, true);
const url = await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
console.log(
  JSON.stringify({
    url,
    mode: 'E1',
    topology: 'single_host_loopback',
    providers: ['mock'],
    external_business_writes: false,
  }),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
