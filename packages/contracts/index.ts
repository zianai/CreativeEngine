import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Versioned wire contracts shared by REST, CLI, MCP and the persistent worker. */
export const PROTOCOL_VERSION = '1.0.0';
export const IdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'Expected a safe opaque identifier');
export const BUILTIN_WORKFLOWS = [
  'buyer-proposal',
  'product-concept',
  'ecommerce-listing',
  'marketing-creative',
] as const;
export const WorkflowSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Skill IDs must be lowercase safe slugs');
export const FidelitySchema = z.enum(['strict', 'controlled', 'exploratory']);
export const StrategySchema = z.enum(['reuse', 'compose', 'edit', 'generate', 'blocked']);
export const StageSchema = z.enum(['existing_sku', 'prototype', 'concept']);
export const DeliveryTargetSchema = z.enum(['internal_review', 'buyer_review', 'listing', 'marketing']);
export const TaskStatusSchema = z.enum([
  'draft',
  'needs_input',
  'planned',
  'queued',
  'running',
  'reconciling',
  'qa_pending',
  'revision_pending',
  'review_pending',
  'approved',
  'rejected',
  'completed',
  'failed',
  'blocked',
  'cancelled',
]);
export const EvidenceStatusSchema = z.enum(['verified', 'supplier_claim', 'unverified', 'concept']);
const shortText = z.string().trim().min(1).max(500);
const changes = z.array(shortText).max(40);
export const ProductProfileSchema = z.object({
  product_id: IdSchema,
  stage: StageSchema,
  truth_snapshot_id: IdSchema.optional(),
});
export type ProductProfile = z.infer<typeof ProductProfileSchema>;
export const ClaimSchema = z.object({ name: shortText, value: z.string().trim().min(1).max(2000) });
export const DeliveryRuleDefinitionSchema = z
  .object({
    id: IdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    source: z.string().min(1).max(2000),
    source_date: z.iso.date(),
    scope: z.enum(['user_defined', 'official']),
    rules: z
      .object({
        min_width: z.number().int().positive().optional(),
        min_height: z.number().int().positive().optional(),
        formats: z
          .array(z.enum(['png', 'jpeg', 'webp']))
          .min(1)
          .optional(),
        max_bytes: z.number().int().positive().optional(),
        required_ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']).optional(),
      })
      .strict(),
  })
  .strict();
export const DeliveryRuleSnapshotSchema = DeliveryRuleDefinitionSchema.extend({
  digest: z.string().length(64),
});
export type DeliveryRuleSnapshot = z.infer<typeof DeliveryRuleSnapshotSchema>;
export const BriefSchema = z.object({
  project_id: IdSchema,
  source: z
    .object({ system: z.string().min(1).max(100), external_id: z.string().min(1).max(200) })
    .optional(),
  workflow: WorkflowSchema,
  skill_input: z
    .record(z.string().max(100), z.unknown())
    .refine(
      (value) => Object.keys(value).length <= 128 && JSON.stringify(value).length <= 64000,
      'Skill input exceeds its bound',
    )
    .default({}),
  intent: shortText.default('product-display'),
  requirements: z.string().trim().min(1).max(12000),
  product: ProductProfileSchema,
  reference_asset_ids: z.array(IdSchema).max(32).default([]),
  fidelity: FidelitySchema.optional(),
  allowed_changes: changes.default([]),
  forbidden_changes: changes.default([]),
  variants: z.number().int().min(1).max(64).default(3),
  scenes: z.array(shortText).min(1).max(32).default(['Studio']),
  aspect_ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']).default('1:1'),
  delivery_target: DeliveryTargetSchema.default('internal_review'),
  provider: IdSchema.default('mock'),
  mode: z.enum(['independent', 'base_variants', 'iterative']).default('independent'),
  budget_usd: z.number().finite().nonnegative().max(100000).default(0),
  claims: z.array(ClaimSchema).max(50).default([]),
  authorized_logo_asset_id: IdSchema.optional(),
  background_asset_id: IdSchema.optional(),
  delivery_rule_id: IdSchema.optional(),
});
export type Brief = z.infer<typeof BriefSchema>;
export const TruthFactSchema = z.object({
  name: shortText,
  value: z.string().trim().min(1).max(2000),
  source_asset_id: IdSchema,
  source_version: shortText,
  evidence_status: EvidenceStatusSchema,
  confirmed_at: z.iso.datetime({ offset: true }),
  external_allowed: z.boolean(),
});
export const TruthSnapshotSchema = z.object({
  id: IdSchema.optional(),
  project_id: IdSchema,
  product_id: IdSchema,
  version: shortText,
  facts: z.array(TruthFactSchema).max(500),
});
export type TruthSnapshot = z.infer<typeof TruthSnapshotSchema>;
export const SourceInputSchema = z.object({
  project_id: IdSchema,
  filename: z
    .string()
    .min(1)
    .max(240)
    .refine((v) => !/[\\/\x00-\x1f]/.test(v) && v !== '.' && v !== '..', 'Filename must not contain a path'),
  data_base64: z
    .string()
    .min(4)
    .max(40_000_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Expected raw base64 bytes'),
  kind: z.enum(['product_photo', 'cutout', 'logo', 'reference', 'document']),
  authorized: z.boolean(),
  verified: z.boolean(),
  source_version: shortText.default('1'),
  sensitive_data_cleared: z.boolean(),
});
export type SourceInput = z.infer<typeof SourceInputSchema>;
export const SkillSnapshotSchema = z.object({
  id: WorkflowSchema,
  version: shortText,
  digest: z.string().length(64),
  prompt_template: z.string().max(20000),
  qa_profile: z.array(z.string()).max(80),
  input_schema: z.record(z.string(), z.unknown()),
  defaults: z.object({ fidelity: FidelitySchema, strategy: z.enum(['reuse', 'compose', 'generate']) }),
});
export const VisualPlanSchema = BriefSchema.extend({
  id: IdSchema,
  version: z.number().int().positive(),
  strategy: StrategySchema,
  fidelity: FidelitySchema,
  skill_version: shortText,
  skill_snapshot: SkillSnapshotSchema.optional(),
  delivery_rule_snapshot: DeliveryRuleSnapshotSchema.optional(),
  requires_human_approval: z.literal(true),
  reasons: z.array(z.string()).max(100),
  blocked_reasons: z.array(z.string()).max(100),
  directions: z.array(z.string()).min(1).max(64),
  created_at: z.iso.datetime({ offset: true }),
});
export type VisualPlan = z.infer<typeof VisualPlanSchema>;
export const ReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewer: shortText,
  notes: z.string().trim().max(8000).default(''),
});
export type ReviewDecision = z.infer<typeof ReviewSchema>;
export const BatchInputSchema = z.object({
  plan_id: IdSchema,
  budget_usd: z.number().finite().nonnegative().max(10000),
  authorize_paid: z.boolean().default(false),
  vision_review: z.boolean().default(false),
  idempotency_key: z.string().min(1).max(200).optional(),
  provider: IdSchema.optional(),
});
export const ProjectSchema = z.object({
  id: IdSchema,
  name: shortText,
  description: z.string().max(8000).default(''),
  product_id: IdSchema.optional(),
  created_at: z.iso.datetime({ offset: true }),
});
export const RevisionSchema = z.object({
  instructions: z.string().trim().min(1).max(4000),
  allowed_changes: changes.optional(),
  budget_usd: z.number().finite().nonnegative().default(0),
  authorize_paid: z.boolean().default(false),
});
export const ReconciliationInputSchema = z.object({
  outcome: z.enum(['no_charge', 'failed_charged']),
  cost_usd: z.number().finite().nonnegative().max(100000),
  reviewer: z.string().trim().min(1).max(200),
  evidence: z.string().trim().min(12).max(8000),
});
export const ExportInputSchema = z.object({
  batch_id: IdSchema,
  asset_ids: z.array(IdSchema).min(1).max(1000).optional(),
});
export const QACheckSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'warn', 'block']),
  detail: z.string(),
});
export const QAIssueSchema = z.object({
  category: z.string(),
  severity: z.enum(['info', 'warning', 'block']),
  description: z.string(),
  suggested_revision: z.string().optional(),
});
export const QAReportSchema = z.object({
  id: IdSchema.optional(),
  project_id: IdSchema.optional(),
  asset_id: IdSchema.optional(),
  created_at: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(['pass', 'warn', 'block']),
  checks: z.array(QACheckSchema),
  issues: z.array(QAIssueSchema),
  vision: z.object({
    status: z.enum(['skipped', 'completed', 'failed', 'unavailable']),
    reason: z.string().optional(),
    cost_usd: z.number().nonnegative().optional(),
    cost_basis: z.string().optional(),
    report: z
      .object({
        issues: z.array(QAIssueSchema),
        uncertainty: z.enum(['low', 'medium', 'high']),
        summary: z.string(),
      })
      .optional(),
  }),
});
export type QAReport = z.infer<typeof QAReportSchema>;
export const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export const AssetProvenanceSchema = z.object({
  project_id: IdSchema,
  batch_id: IdSchema.optional(),
  task_id: IdSchema.optional(),
  reference_asset_ids: z.array(IdSchema),
  truth_snapshot_id: IdSchema.optional(),
  skill_version: z.string(),
  prompt_version: z.string(),
  provider: z.string(),
  model: z.string(),
  sha256: z.string().length(64),
  parent_asset_id: IdSchema.optional(),
  identity: z.enum(['source', 'real_product', 'concept', 'mock']),
});
export const CompiledPromptSchema = z.object({
  version: z.string(),
  text: z.string(),
  skill_version: z.string(),
  skill_digest: z.string().length(64),
  constraints: z.object({ allowed_changes: changes, forbidden_changes: changes, fidelity: FidelitySchema }),
  direction: z.string(),
  scene: z.string(),
  variant: z.number().int().nonnegative(),
});
export const VisualTaskSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  batch_id: IdSchema,
  plan_id: IdSchema,
  status: TaskStatusSchema,
  scene: z.string(),
  variant: z.number().int().nonnegative(),
  direction: z.string(),
  prompt: CompiledPromptSchema,
  provider: IdSchema,
  estimated_cost_usd: z.number().nonnegative(),
  cost_usd: z.number().nonnegative().optional(),
  image_estimated_cost_usd: z.number().nonnegative().optional(),
  revision_controls: z.object({ background: z.string().optional(), color: z.string().optional() }).optional(),
  attempt_count: z.number().int().nonnegative(),
  attempt_id: IdSchema.optional(),
  dependency_task_id: IdSchema.optional(),
  parent_asset_id: IdSchema.optional(),
  asset_id: IdSchema.optional(),
  revision_instructions: z.string().optional(),
  retry_safe: z.boolean().optional(),
  cancel_requested: z.boolean().optional(),
  next_run: z.number().nonnegative().optional(),
  error: z.object({ code: z.string(), message: z.string(), uncertain: z.boolean().optional() }).optional(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});
export type VisualTask = z.infer<typeof VisualTaskSchema>;
export const BatchSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  plan_id: IdSchema,
  provider: IdSchema,
  status: z.enum([...TaskStatusSchema.options, 'paused']),
  provider_config: z.record(z.string(), z.unknown()),
  provider_config_hash: z.string().length(64),
  budget_usd: z.number().nonnegative(),
  cost_usd: z.number().nonnegative(),
  reserved_usd: z.number().nonnegative(),
  estimated_cost_usd: z.number().nonnegative().optional(),
  authorize_paid: z.boolean(),
  vision_review: z.boolean().optional(),
  vision_config: z
    .object({
      model: z.string(),
      reservation_usd: z.number().positive(),
      input_usd_per_million: z.number().positive(),
      output_usd_per_million: z.number().positive(),
    })
    .optional(),
  fingerprint: z.string().length(64),
  created_at: z.iso.datetime({ offset: true }),
  tasks: z.array(VisualTaskSchema).optional(),
});
export type Batch = z.infer<typeof BatchSchema>;
export const ReviewDecisionSchema = ReviewSchema.extend({
  id: IdSchema,
  project_id: IdSchema,
  asset_id: IdSchema,
  created_at: z.iso.datetime({ offset: true }),
});
export const SourceAssetSchema = SourceInputSchema.omit({ data_base64: true }).extend({
  id: IdSchema,
  identity: z.literal('source'),
  sha256: z.string().length(64),
  size_bytes: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  format: z.string().optional(),
  review_status: z.enum(['pending', 'approved', 'rejected']),
  created_at: z.iso.datetime({ offset: true }),
  url: z.string().optional(),
});
export const VisualAssetSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  batch_id: IdSchema,
  task_id: IdSchema,
  attempt_id: IdSchema,
  filename: z.string(),
  sha256: z.string().length(64),
  size_bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.enum(['png', 'jpeg', 'webp']),
  identity: z.enum(['real_product', 'concept', 'mock']),
  review_status: z.enum(['pending', 'approved', 'rejected']),
  parent_asset_id: IdSchema.optional(),
  background_asset_id: IdSchema.optional(),
  authorized_logo_asset_id: IdSchema.optional(),
  reference_asset_ids: z.array(IdSchema),
  truth_snapshot_id: IdSchema.optional(),
  skill_version: z.string(),
  prompt: CompiledPromptSchema,
  provider: z.string(),
  model: z.string(),
  qa_id: IdSchema,
  allowed_uses: z.array(DeliveryTargetSchema),
  created_at: z.iso.datetime({ offset: true }),
  url: z.string().optional(),
  qa: QAReportSchema.nullable().optional(),
  reviews: z.array(ReviewDecisionSchema).optional(),
});
export type VisualAsset = z.infer<typeof VisualAssetSchema>;
export const ExecutionAttemptSchema = z.object({
  id: IdSchema,
  task_id: IdSchema,
  project_id: IdSchema.optional(),
  provider: IdSchema,
  status: z.enum([
    'started',
    'succeeded',
    'failed',
    'unknown',
    'interrupted',
    'uncertain',
    'reconciling',
    'review_uncertain',
  ]),
  image_cost_usd: z.number().nonnegative().optional(),
  vision_cost_usd: z.number().nonnegative().optional(),
  vision_cost_basis: z.string().optional(),
  request_id: z.string().optional(),
  estimated_cost_usd: z.number().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  error: z.object({ code: z.string(), message: z.string(), uncertain: z.boolean().optional() }).optional(),
  result: z
    .object({
      provider: z.string(),
      model: z.string(),
      costUsd: z.number().nonnegative(),
      mock: z.boolean(),
      requestId: z.string().optional(),
      sessionId: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  created_at: z.iso.datetime({ offset: true }),
  finished_at: z.iso.datetime({ offset: true }).optional(),
});
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;
export const ExternalPlanSummarySchema = VisualPlanSchema.pick({
  id: true,
  version: true,
  workflow: true,
  source: true,
  strategy: true,
  fidelity: true,
  product: true,
  delivery_target: true,
  skill_version: true,
});
export const ExternalQASummarySchema = z.object({
  status: z.enum(['pass', 'warn', 'block']),
  checks: z.array(QACheckSchema.omit({ detail: true })),
  vision: z.object({ status: z.enum(['skipped', 'completed', 'failed', 'unavailable']) }),
});
export const ExternalAssetSchema = VisualAssetSchema.omit({ prompt: true, reviews: true, qa: true }).extend({
  reviews: z.array(ReviewDecisionSchema.pick({ id: true, decision: true, created_at: true })),
  qa: ExternalQASummarySchema,
});
const ExportManifestBaseSchema = z.object({
  schema_version: z.literal('1.0.0'),
  id: IdSchema,
  batch_id: IdSchema,
  created_at: z.iso.datetime({ offset: true }),
  mock: z.boolean(),
  external_use_warning: z.string().nullable(),
});
export const InternalExportManifestSchema = ExportManifestBaseSchema.extend({
  audience: z.literal('internal'),
  project: ProjectSchema,
  plan: VisualPlanSchema,
  truth_snapshots: z.array(TruthSnapshotSchema),
  assets: z.array(VisualAssetSchema.extend({ export_filename: z.string() })).min(1),
});
export const ExternalExportManifestSchema = ExportManifestBaseSchema.extend({
  audience: z.literal('external'),
  project: ProjectSchema.pick({ id: true }),
  plan: ExternalPlanSummarySchema,
  truth_snapshots: z.array(
    TruthSnapshotSchema.extend({
      facts: z.array(
        TruthFactSchema.extend({ evidence_status: z.literal('verified'), external_allowed: z.literal(true) }),
      ),
      redacted: z.literal(true),
      snapshot_sha256: z.string().length(64),
    }),
  ),
  assets: z.array(ExternalAssetSchema.extend({ export_filename: z.string() })).min(1),
});
export const ExportManifestSchema = z.discriminatedUnion('audience', [
  InternalExportManifestSchema,
  ExternalExportManifestSchema,
]);
export const ExportPackageSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  batch_id: IdSchema,
  manifest: ExportManifestSchema,
  created_at: z.iso.datetime({ offset: true }),
  download_url: z.string(),
});
export type ExportPackage = z.infer<typeof ExportPackageSchema>;
export const CreativeBriefSchema = BriefSchema.extend({
  id: IdSchema,
  created_at: z.iso.datetime({ offset: true }),
});
export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = status;
  }
}
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
export const contractSchemas = {
  CreativeBriefInput: BriefSchema,
  CreativeBrief: CreativeBriefSchema,
  VisualPlan: VisualPlanSchema,
  ProductTruthSnapshot: TruthSnapshotSchema,
  SourceAssetImport: SourceInputSchema,
  SourceAsset: SourceAssetSchema,
  ReviewDecision: ReviewDecisionSchema,
  ReviewInput: ReviewSchema,
  BatchInput: BatchInputSchema,
  Project: ProjectSchema,
  ProductProfile: ProductProfileSchema,
  QAReport: QAReportSchema,
  Revision: RevisionSchema,
  ReconciliationInput: ReconciliationInputSchema,
  ExportInput: ExportInputSchema,
  ExecutionAttempt: ExecutionAttemptSchema,
  Batch: BatchSchema,
  VisualTask: VisualTaskSchema,
  VisualAsset: VisualAssetSchema,
  ExportPackage: ExportPackageSchema,
  DeliveryRule: DeliveryRuleDefinitionSchema,
  DeliveryRuleSnapshot: DeliveryRuleSnapshotSchema,
  ExportManifest: ExportManifestSchema,
  InternalExportManifest: InternalExportManifestSchema,
  ExternalExportManifest: ExternalExportManifestSchema,
  ExternalPlanSummary: ExternalPlanSummarySchema,
  ExternalAsset: ExternalAssetSchema,
};
export function jsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(contractSchemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, {
        io: name.endsWith('Input') || ['SourceAssetImport', 'Revision'].includes(name) ? 'input' : 'output',
      }),
    ]),
  );
}
