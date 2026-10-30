import { z } from 'zod';
import { TruthSnapshotSchema, SourceInputSchema } from '../../contracts/index.js';
import type { Core } from '../../core/service.js';
export const TradeCaseRequestSchema = z
  .object({
    case_id: z.string().min(1),
    buyer_requirements: z.string().min(1),
    product_id: z.string().min(1),
    product_truth_snapshot: TruthSnapshotSchema.omit({ project_id: true, id: true }).optional(),
    evidence_references: z.array(z.string()).default([]),
    source_assets: z
      .array(
        SourceInputSchema.omit({ project_id: true }).extend({
          external_id: z.string().trim().min(1).max(200),
        }),
      )
      .default([]),
    visual_intent: z.string().default('product-showcase'),
    delivery_target: z.enum(['buyer_review', 'internal_review']).default('buyer_review'),
  })
  .superRefine((request, ctx) => {
    const ids = new Set<string>();
    request.source_assets.forEach((asset, index) => {
      if (ids.has(asset.external_id))
        ctx.addIssue({
          code: 'custom',
          path: ['source_assets', index, 'external_id'],
          message: 'Duplicate external_id creates ambiguous evidence mapping',
        });
      ids.add(asset.external_id);
    });
    if (request.product_truth_snapshot && request.product_truth_snapshot.product_id !== request.product_id)
      ctx.addIssue({
        code: 'custom',
        path: ['product_truth_snapshot', 'product_id'],
        message: 'Truth snapshot product_id must match the requested product',
      });
    request.product_truth_snapshot?.facts.forEach((fact, index) => {
      if (!ids.has(fact.source_asset_id))
        ctx.addIssue({
          code: 'custom',
          path: ['product_truth_snapshot', 'facts', index, 'source_asset_id'],
          message: 'Truth evidence must reference a source_assets external_id in this request',
        });
    });
  });
export async function planTradeCase(core: Core, input: unknown) {
  const request = TradeCaseRequestSchema.parse(input);
  const project = core.project({ name: `TradeCase ${request.case_id}`, product_id: request.product_id });
  const assets = [],
    mapping = new Map<string, string>();
  for (const source of request.source_assets) {
    const asset = await core.importAsset({ ...source, project_id: project.id });
    assets.push(asset);
    mapping.set(source.external_id, asset.id);
  }
  const truth = request.product_truth_snapshot
    ? core.truth({
        ...request.product_truth_snapshot,
        facts: request.product_truth_snapshot.facts.map((f) => ({
          ...f,
          source_asset_id: mapping.get(f.source_asset_id) ?? f.source_asset_id,
        })),
        project_id: project.id,
        product_id: request.product_id,
      })
    : undefined;
  const brief = core.brief({
    project_id: project.id,
    source: { system: 'tradecase', external_id: request.case_id },
    workflow: 'buyer-proposal',
    intent: request.visual_intent,
    requirements: request.buyer_requirements,
    product: { product_id: request.product_id, stage: 'existing_sku', truth_snapshot_id: truth?.id },
    reference_asset_ids: assets.filter((a) => a.kind !== 'document').map((a) => a.id),
    delivery_target: request.delivery_target,
    variants: 1,
    provider: 'mock',
  });
  return core.plan(brief.id);
}
export function tradeCaseResult(core: Core, batchId: string) {
  const batch = core.batch(batchId),
    assets = core.store.list('asset', batch.project_id).filter((a) => a.batch_id === batchId);
  return {
    batch_id: batch.id,
    execution_status: batch.status,
    approved_asset_ids: assets.filter((a) => a.review_status === 'approved').map((a) => a.id),
    qa_summary: assets.map((a) => ({ asset_id: a.id, qa: core.asset(a.id).qa })),
    export_package: core.store
      .list('export', batch.project_id)
      .filter((e) => e.batch_id === batchId)
      .map(({ path, ...e }) => e),
  };
}
