/** Read-only metadata exchange; never creates a review, grant, factual claim or business approval. */
import { Core } from './service.js';
import { hash } from './files.js';
export function evaluationSnapshot(core: Core, batchId: string) {
  const batch = core.batch(batchId),
    plan = core.require('plan', batch.plan_id);
  const assets = core.store.list('asset', batch.project_id).filter((a) => a.batch_id === batch.id);
  return {
    schema_version: '1.0.0',
    project: 'creative-engine',
    batch_id: batchId,
    plan_sha256: hash(JSON.stringify(plan)),
    purpose: plan.delivery_target,
    product_id: plan.product.product_id,
    skill_version: plan.skill_version,
    skill_sha256: plan.skill_snapshot.digest,
    business_pilot_status: 'not_evaluable',
    human_reviewers: [],
    actual_billed_usd: batch.cost_summary.actual_cost_usd,
    estimated_cost_usd: batch.cost_summary.gross_spend_estimated_usd,
    billing_status: batch.cost_summary.charge_status,
    assets: assets.map((a) => ({
      asset_id: a.id,
      subject_sha256: a.sha256,
      identity: a.identity,
      provider: a.provider,
      model: a.model,
      prompt_sha256: hash(JSON.stringify(a.prompt)),
      attempt_id: a.attempt_id,
      source_refs: a.reference_asset_ids,
      truth_snapshot_id: a.truth_snapshot_id ?? null,
      qa: core.require('qa', a.qa_id),
      review_status: a.review_status,
      required_dimensions: [
        'product_identity_fidelity',
        'claim_and_text_truth',
        'composition_and_hierarchy',
        'brand_consistency',
        'technical_delivery',
        'overall_usable',
      ],
      use_authorization: 'not_established_by_evaluation_export',
    })),
    limitations: [
      'No human ratings or billing were fabricated.',
      'A source/QA assertion does not certify a real product.',
      'Provider identity is retained here; blinded reviewer cards must hide it separately.',
    ],
  };
}
