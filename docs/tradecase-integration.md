# TradeCase integration boundary

Creative Engine never opens the TradeCase database or imports its internal agent state. Use HTTP from Python (`examples/tradecase_client.py`) or the typed adapter in `packages/integrations/tradecase/`. The boundary receives case_id, buyer_requirements, product_truth_snapshot, evidence_references, source_assets, visual_intent and delivery_target. Store the external case identity as `source.system/external_id` on the brief and plan.

Upload original evidence first; map external source IDs to returned Creative Engine asset IDs before creating ProductTruthSnapshot. Fact versions and confirmed_at must come from the responsible supplier/product owner, never the model. Verified source and usage-rights attestations are caller-owned decisions.

Review the returned plan, submit with a project budget and stable idempotency key, poll durable batch IDs or subscribe to SSE. Return execution_status, approved_asset_ids, QA summaries and export_package to the Case. A blocked plan is a request for more evidence or narrower permitted changes. Do not make an unapproved output a buyer attachment.

No TradeCase source changes were made. No email, listing publication or advertising publication endpoint exists.
