#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import YAML from 'yaml';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
const cli = new Command()
  .name('creative')
  .description('Creative Engine local production tools')
  .option('--json', 'JSON output (default)');
async function withCore(fn: (core: Core) => unknown) {
  const core = new Core();
  try {
    const value = await fn(core);
    if (value !== undefined) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  } finally {
    core.close();
  }
}
async function input(path: string) {
  const raw = await readFile(resolve(path), 'utf8');
  return path.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
}
cli
  .command('init')
  .option('--name <name>', 'Project name', 'My creative project')
  .action((opts) => withCore((c) => c.project({ name: opts.name })));
cli.command('doctor').action(() =>
  withCore(async (c) => ({
    node: process.version,
    data_dir: c.root,
    providers: await c.providerList(),
    skills: c.skills().map((s: any) => ({ id: s.id, version: s.version })),
  })),
);
cli.command('serve').action(async () => {
  await import('../server/index.js');
});
cli.command('mcp').action(async () => {
  await import('../mcp/index.js');
});
cli.command('worker').action(async () => {
  await import('../worker/index.js');
});
cli
  .command('plan')
  .requiredOption('--brief <path>')
  .action((opts) =>
    withCore(async (c) => {
      const b = c.brief(await input(opts.brief));
      return c.plan(b.id);
    }),
  );
cli
  .command('truth')
  .requiredOption('--file <path>')
  .action((opts) => withCore(async (c) => c.truth(await input(opts.file))));
const projects = cli.command('projects');
projects.command('list').action(() => withCore((c) => ({ items: c.store.list('project') })));
const providers = cli.command('providers');
providers.command('list').action(() => withCore(async (c) => ({ items: await c.providerList() })));
const skills = cli.command('skills');
skills.command('list').action(() => withCore((c) => ({ items: c.skills() })));
const batch = cli.command('batch');
batch
  .command('run')
  .requiredOption('--plan <path-or-id>')
  .option('--budget <usd>', 'Maximum batch cost', '0')
  .option('--authorize-paid', 'Authorize up to the explicit budget')
  .option('--vision-review', 'Request configured paid Vision QA')
  .option('--wait', 'Process queue in this CLI process')
  .option('--idempotency-key <key>')
  .action((opts) =>
    withCore(async (c) => {
      let planId = opts.plan;
      if (planId.endsWith('.json')) {
        const plan = await input(planId);
        const stored = c.require('plan', plan.id);
        if (JSON.stringify(plan) !== JSON.stringify(stored))
          throw new Error('Plan file must match a stored immutable plan');
        planId = plan.id;
      }
      const b = c.createBatch({
        plan_id: planId,
        budget_usd: Number(opts.budget),
        authorize_paid: !!opts.authorizePaid,
        vision_review: !!opts.visionReview,
        idempotency_key: opts.idempotencyKey,
      });
      if (opts.wait) {
        const w = new Worker(c);
        await w.drain(600000);
      }
      return c.batch(b.id);
    }),
  );
batch.command('status <id>').action((id) => withCore((c) => c.batch(id)));
for (const action of ['resume', 'cancel', 'pause'])
  batch.command(`${action} <id>`).action((id) => withCore((c) => c.controlBatch(id, action)));
const assets = cli.command('assets');
assets
  .command('list')
  .option('--project <id>')
  .action((opts) =>
    withCore((c) => ({ items: c.store.list('asset', opts.project).map((a) => c.asset(a.id)) })),
  );
assets
  .command('import <file>')
  .requiredOption('--project <id>')
  .option('--kind <kind>', 'Source kind', 'product_photo')
  .option('--authorized', 'Confirm usage rights')
  .option('--verified', 'Confirm source authenticity')
  .option('--sensitive-data-cleared', 'Confirm sensitive data cleared')
  .action((file, opts) =>
    withCore(async (c) =>
      c.importAsset({
        project_id: opts.project,
        filename: basename(file),
        data_base64: (await readFile(resolve(file))).toString('base64'),
        kind: opts.kind,
        authorized: !!opts.authorized,
        verified: !!opts.verified,
        sensitive_data_cleared: !!opts.sensitiveDataCleared,
        source_version: '1',
      }),
    ),
  );
assets
  .command('review <id>')
  .requiredOption('--decision <approved-or-rejected>')
  .requiredOption('--reviewer <name>')
  .option('--notes <text>', 'Review rationale', '')
  .action((id, opts) => withCore((c) => c.review(id, opts)));
cli
  .command('revise <task-id>')
  .requiredOption('--instructions <text>')
  .option('--budget <usd>', 'Revision budget', '0')
  .option('--authorize-paid')
  .action((id, opts) =>
    withCore((c) =>
      c.revise(id, {
        instructions: opts.instructions,
        budget_usd: Number(opts.budget),
        authorize_paid: !!opts.authorizePaid,
      }),
    ),
  );
cli
  .command('cleanup <project-id>')
  .option('--confirm-project <exact-name>', 'Permanently purge this inactive project; otherwise dry run')
  .action((id, opts) => withCore((c) => c.purgeProject(id, opts.confirmProject)));
cli
  .command('reconcile <task-id>')
  .requiredOption('--outcome <no_charge-or-failed_charged>')
  .requiredOption('--reviewer <name>')
  .requiredOption('--evidence <text>')
  .option('--cost <usd>', 'Confirmed charge', '0')
  .action((id, opts) =>
    withCore((c) =>
      c.reconcile(id, {
        outcome: opts.outcome,
        reviewer: opts.reviewer,
        evidence: opts.evidence,
        cost_usd: Number(opts.cost),
      }),
    ),
  );
cli.command('export <batch-id>').action((id) => withCore((c) => c.export({ batch_id: id })));
try {
  await cli.parseAsync(process.argv);
} catch (error: any) {
  process.stderr.write(
    JSON.stringify({ error: { code: error.code ?? 'CLI_ERROR', message: error.message } }) + '\n',
  );
  process.exitCode = 1;
}
