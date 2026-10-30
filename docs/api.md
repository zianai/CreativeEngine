# REST, CLI and MCP

Local server: `pnpm serve`, http://127.0.0.1:4310. API schema: `/v1/openapi.json`. Studio and API use the same local origin. Remote origins and non-loopback Host headers are rejected. Optional `CREATIVE_API_TOKEN` requires `Authorization: Bearer …` on all API requests (Studio is intended for the default local no-token mode).

Lists use `{items,total,offset,limit}`, with `project_id` filters where relevant. Errors use `{error:{code,message,details?}}`. JSON upload accepts only bounded base64 data, never server filesystem paths or remote URLs. Default max file is 20 MiB and decoded raster is 40 MP. IDs are independent of external systems.

| Route | Function |
|---|---|
| GET /v1/health, /providers, /skills, /dashboard | Read readiness and capability status |
| POST/GET /v1/projects | Create/list projects |
| POST/GET /v1/truth-snapshots | Create/list immutable fact snapshots |
| POST /v1/assets/import | Import source; rights, authenticity and sensitive-data attestations explicit |
| GET /v1/assets/:id, /file | Metadata/provenance and media |
| POST /v1/briefs | Save normalized brief |
| POST /v1/briefs/:id/plan | Free dry-run planning |
| GET /v1/plans/:id | Read frozen plan |
| POST /v1/batches | Queue a reviewed plan, budget, optional paid consent and vision_review |
| GET /v1/batches/:id | Tasks and aggregate cost |
| POST /v1/batches/:id/pause, /resume, /cancel | Persistent control |
| GET /v1/tasks/:id | Task and attempts |
| POST /v1/tasks/:id/revise | New revision linked to parent |
| POST /v1/assets/:id/review | Named human review |
| POST /v1/exports | Approved-only ZIP manifest package |
| GET /v1/exports/:id, /file | Package metadata/download |
| GET /v1/events | SSE, resume using Last-Event-ID or ?after=sequence |

Batch submission accepts `Idempotency-Key` header or `idempotency_key` field. Same key+same inputs returns the original batch; differing inputs return 409. Repeating ordinary create endpoints creates new records. Long requests return batch IDs immediately.

```json
{"plan_id":"plan_…","budget_usd":0,"authorize_paid":false,"vision_review":false,"idempotency_key":"campaign-001"}
```

`vision_review:true` requires an explicitly configured model, token pricing, reservation and paid consent, including for locally composed or Mock images. Model capability checks alone do not establish live generation success.

CLI runs directly on the same local SQLite Core. Use `pnpm creative --help`, `pnpm creative doctor`, `pnpm creative plan --brief brief.yaml`, `pnpm creative batch run --plan plan-id --budget 0 --wait`, `pnpm creative assets review asset-id --decision approved --reviewer 'Your name'`, `pnpm creative export batch-id`. Output is JSON. Without `--wait`, server or standalone worker processes the queue. CLI plan never calls a paid model.

MCP stdio: `pnpm mcp` (or `node_modules/.bin/tsx apps/mcp/index.ts`). Configure command with an absolute executable and working directory; pass CREATIVE_DATA_DIR to share server storage. Tools: creative_project, creative_import_asset, creative_truth, creative_plan, creative_generate, creative_batch_status, creative_list_assets, creative_review, creative_revise, creative_export, creative_batch_control. Each tool exposes explicit JSON input Schema. Generation returns a durable batch ID. Review tools record a human decision; calling agents must not invent a human approval.

Delivery rules: `GET /v1/delivery-rules` lists source/date/version-tagged rule bundles. Briefs may select `delivery_rule_id`; plans freeze its full digest and constraints. `custom-square` is an internal user-defined example, not an Amazon/eBay/other marketplace policy claim. Update or add rule YAML with a new version and a source document before use.

Manual reconciliation: `POST /v1/tasks/:id/reconcile` accepts `{outcome:"no_charge"|"failed_charged",cost_usd,reviewer,evidence}`. Evidence must describe the actual provider/billing check, not a guessed timeout outcome. A recoverable image receipt is processed by the worker instead. A confirmed no-charge failure becomes eligible for bounded manual resume; confirmed charged failure is recorded without resubmitting.

Local retention: `pnpm creative cleanup project-id` previews the records to remove. `--confirm-project 'Exact project name'` permanently removes that inactive project's prompts, assets, facts, task history, and managed files. Active or unresolved paid tasks block cleanup. Back up required delivery records first. This command is never run automatically.
