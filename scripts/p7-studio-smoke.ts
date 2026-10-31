/** Loopback UI smoke; synthetic unknown-receipt injection, no paid provider. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { buildApp } from '../apps/server/app.js';
import { Core } from '../packages/core/service.js';
import { MockProvider } from '../packages/providers/mock/index.js';
const root = await mkdtemp(join(tmpdir(), 'p7-studio-'));
const core = new Core(root, new Map([['mock', new MockProvider(join(root, 'mock'))]]));
process.env.CREATIVE_API_TOKEN = 'P7-SYNTHETIC-BROWSER-TOKEN';
const project = core.project({ name: 'P7 SYNTHETIC ONLY' });
const brief = core.brief({
  project_id: project.id,
  workflow: 'product-concept',
  product: { product_id: 'TEST', stage: 'concept' },
  requirements: 'Synthetic unknown receipt injection',
  provider: 'mock',
  variants: 1,
});
const plan = core.plan(brief.id);
const batch = core.createBatch({ plan_id: plan.id, budget_usd: 0, idempotency_key: 'synthetic' });
core.store.saveTask({ ...core.store.tasks(batch.id)[0], status: 'reconciling' });
core.updateBatch(batch.id);
const { app } = await buildApp(core, false);
let browser;
try {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch();
  const page = await browser.newPage({
    extraHTTPHeaders: { authorization: 'Bearer P7-SYNTHETIC-BROWSER-TOKEN' },
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === url ? route.continue() : route.abort(),
  );
  await page.goto(url);
  await page.getByLabel('当前项目').selectOption(project.id);
  await page.getByRole('heading', { name: '项目总览', exact: true }).waitFor();
  await page.getByText('待核对', { exact: true }).first().waitFor();
  const screenshots = process.env.TMPDIR! + '/../data/studio';
  await mkdir(screenshots, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: join(screenshots, `studio-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  assert.equal(core.store.list('asset').length, 0);
  console.log('PASS actual Studio + HTTP, unknown charge is 待核对, desktop/mobile captured, paid_calls=0');
} finally {
  if (browser) await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
