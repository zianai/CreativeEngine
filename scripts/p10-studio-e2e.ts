/** Real browser/API/SQLite. Synthetic actors only, design and business approval remain pending. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { Core } from '../packages/core/service.js';
import { MockProvider } from '../packages/providers/mock/index.js';
import { buildApp } from '../apps/server/app.js';
import { Worker } from '../packages/core/worker.js';
import { hash } from '../packages/core/files.js';
const root = await mkdtemp(join(tmpdir(), 'ce-browser-')),
  evidence = resolve('docs/validation/p8-p10/evidence/studio');
await mkdir(evidence, { recursive: true });
process.env.CREATIVE_API_TOKEN = 'SYNTHETIC-LOCAL-STUDIO';
const core = new Core(root, new Map([['mock', new MockProvider(join(root, 'provider-receipts/mock'))]]));
const project = core.project({ name: 'SYNTHETIC P10 — NOT BUSINESS APPROVAL' });
const brief = core.brief({
  project_id: project.id,
  workflow: 'product-concept',
  product: { product_id: 'TEST', stage: 'concept' },
  requirements: 'Synthetic geometry for interface verification',
  variants: 1,
});
const plan = core.plan(brief.id);
const batch = core.createBatch({ plan_id: plan.id, budget_usd: 0 });
await new Worker(core).drain();
const unknown = core.createBatch({ plan_id: plan.id, budget_usd: 0 });
core.store.saveTask({ ...core.store.tasks(unknown.id)[0], status: 'reconciling' });
core.updateBatch(unknown.id);
const { app } = await buildApp(core, false);
let browser;
const captures: any[] = [];
const audits: any[] = [];
try {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === url ? route.continue() : route.abort(),
  );
  await page.goto(url);
  await page.getByRole('button', { name: '连接本地服务', exact: true }).click();
  await page.getByLabel('本地访问令牌').fill('SYNTHETIC-LOCAL-STUDIO');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByLabel('当前项目').selectOption(project.id);
  await page.getByText('待核对', { exact: true }).first().waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: /项目总览/ }).click();
    await page.getByText('待核对', { exact: true }).first().waitFor();
    const path = join(evidence, `dashboard-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    captures.push({ file: path, sha256: hash(await readFile(path)) });
  }
  await page.getByRole('button', { name: /审核与交付/ }).click();
  await page.getByRole('button', { name: '检查与审核 ↗' }).first().click();
  const approve = page.getByRole('button', { name: '批准此资产' });
  assert(await approve.isDisabled());
  await page.getByLabel('审核人', { exact: true }).fill('SYNTHETIC E1 TEST ACTOR');
  for (const round of ['pending', 'approved']) {
    if (round === 'approved') {
      await approve.click();
      await page.getByText('素材已批准，可纳入交付包。', { exact: true }).waitFor();
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('dialog[open]').evaluate((dialog) => {
        dialog.scrollTop = 0;
      });
      const audit = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        dialogs: Array.from(document.querySelectorAll('dialog[open]')).map((e) => ({
          named: Boolean(e.getAttribute('aria-labelledby')),
          width: e.getBoundingClientRect().width,
        })),
        images: Array.from(document.images)
          .filter((i) => i.getBoundingClientRect().width > 0)
          .map((i) => ({ alt: Boolean(i.alt), loaded: i.complete && i.naturalWidth > 0 })),
        missingLabels: Array.from(
          document.querySelectorAll('input:not([type=hidden]),select,textarea'),
        ).filter(
          (e: any) =>
            e.getBoundingClientRect().width > 0 && !e.labels?.length && !e.getAttribute('aria-label'),
        ).length,
      }));
      assert.equal(audit.overflow, false);
      assert(audit.dialogs.every((d) => d.named));
      assert(audit.images.every((i) => i.alt && i.loaded));
      assert.equal(audit.missingLabels, 0);
      audits.push({ round, width, ...audit });
      const path = join(evidence, `asset-${round}-${width}.png`);
      await page.screenshot({ path, fullPage: true });
      captures.push({ file: path, sha256: hash(await readFile(path)) });
      await approve.scrollIntoViewIfNeeded();
      const decisionPath = join(evidence, `asset-${round}-decision-${width}.png`);
      await page.screenshot({ path: decisionPath, fullPage: true });
      captures.push({ file: decisionPath, sha256: hash(await readFile(decisionPath)) });
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(core.store.list('review').length, 1);
  assert(
    !(await page.evaluate(
      () =>
        JSON.stringify(localStorage).includes('SYNTHETIC-LOCAL-STUDIO') ||
        JSON.stringify(sessionStorage).includes('SYNTHETIC-LOCAL-STUDIO'),
    )),
  );
  const report = {
    scope: 'E1 actual browser HTTP SQLite synthetic review',
    captures,
    audits,
    design_status: 'design_pending',
    business_pilot_status: 'BLOCKED_EXTERNAL',
    paid_calls: 0,
    external_business_writes: 0,
  };
  await writeFile(join(evidence, 'render-manifest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
