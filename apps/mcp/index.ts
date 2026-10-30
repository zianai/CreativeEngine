import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
import {
  BriefSchema,
  SourceInputSchema,
  TruthSnapshotSchema,
  ReviewSchema,
} from '../../packages/contracts/index.js';
const core = new Core(),
  worker = new Worker(core);
worker.start();
const server = new McpServer({ name: 'creative-engine', version: '1.0.0' });
const register = (
  name: string,
  description: string,
  schema: z.ZodObject<any>,
  handler: (input: any) => unknown,
) =>
  server.registerTool(name, { description, inputSchema: schema.shape }, async (input: any) => {
    try {
      const result = await handler(schema.parse(input));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent:
          typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : { result },
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: { code: e.code ?? 'VALIDATION_ERROR', message: e.message } }),
          },
        ],
      };
    }
  });
register(
  'creative_project',
  'Create an independent visual project',
  z.object({ name: z.string().min(1) }),
  (i) => core.project(i),
);
register(
  'creative_import_asset',
  'Import an authorized raster or document; base64 only, no arbitrary file paths',
  SourceInputSchema,
  (i) => core.importAsset(i),
);
register('creative_truth', 'Create immutable source-backed product facts', TruthSnapshotSchema, (i) =>
  core.truth(i),
);
register('creative_plan', 'Dry-run planning only; does not call paid image models', BriefSchema, (i) =>
  core.plan(core.brief(i).id),
);
register(
  'creative_generate',
  'Queue an approved visual plan; returns durable batch ID',
  z.object({
    plan_id: z.string(),
    budget_usd: z.number().nonnegative(),
    authorize_paid: z.boolean().default(false),
    vision_review: z.boolean().default(false),
    idempotency_key: z.string().optional(),
  }),
  (i) => core.createBatch(i),
);
register(
  'creative_batch_status',
  'Inspect a durable batch and all tasks',
  z.object({ batch_id: z.string() }),
  (i) => core.batch(i.batch_id),
);
register(
  'creative_list_assets',
  'List project assets with QA and provenance',
  z.object({ project_id: z.string() }),
  (i) => ({ items: core.store.list('asset', i.project_id).map((a) => core.asset(a.id)) }),
);
register(
  'creative_review',
  'Record an explicit human review; agents must not invent reviewer approval',
  z.object({ asset_id: z.string(), ...ReviewSchema.shape }),
  (i) => core.review(i.asset_id, { decision: i.decision, reviewer: i.reviewer, notes: i.notes }),
);
register(
  'creative_revise',
  'Create a new version from review instructions',
  z.object({
    task_id: z.string(),
    instructions: z.string(),
    budget_usd: z.number().nonnegative().default(0),
    authorize_paid: z.boolean().default(false),
  }),
  (i) => core.revise(i.task_id, i),
);
register(
  'creative_export',
  'Export only approved outputs with a provenance manifest',
  z.object({ batch_id: z.string(), asset_ids: z.array(z.string()).optional() }),
  (i) => core.export(i),
);
register(
  'creative_reconcile',
  'Record human-supplied provider billing evidence for an ambiguous call; never guess the outcome',
  z.object({
    task_id: z.string(),
    outcome: z.enum(['no_charge', 'failed_charged']),
    cost_usd: z.number().nonnegative(),
    reviewer: z.string(),
    evidence: z.string().min(12),
  }),
  (i) => core.reconcile(i.task_id, i),
);
register(
  'creative_batch_control',
  'Pause, resume or cancel a batch',
  z.object({ batch_id: z.string(), action: z.enum(['pause', 'resume', 'cancel']) }),
  (i) => core.controlBatch(i.batch_id, i.action),
);
await server.connect(new StdioServerTransport());
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void worker.stop().then(async () => {
      await server.close();
      core.close();
      process.exit(0);
    });
  });
