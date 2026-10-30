# Image Provider protocol

Implement `ImageProvider` from `packages/providers/types.ts` and register it in `createProviders`. Every provider declares generation, editing, exact sizing, payment, and concurrency capabilities. Optional batch, unattended operation, and cancellation capabilities are explicit. Never silently substitute providers or models.

`ProviderRequest` includes stable task and attempt IDs, a compiled prompt, bounded dimensions, an internal output directory, approved local reference paths, and an optional cancellation signal. External callers cannot supply local paths through the REST API. The core resolves authorized registry assets to these paths. `ProviderResult` contains a validated local raster path, provider and model identifiers, actual or explicitly estimated cost, mock identity, and any external session/request identifier.

The provider must persist a result receipt after validated bytes are written and before returning. `getResult(attemptId)` recovers the completed local receipt after a worker or database failure. A missing receipt is **not** proof that a remote request failed. Sync image APIs do not expose a general request-ID image retrieval endpoint; an uncertain call remains reconciling until an operator has evidence.

`ProviderError` distinguishes retryable errors (for example an explicit 429 rejection), permanent configuration/input failure, and uncertain execution. Never automatically retry ambiguous post-submission network failures. The core owns retry ceilings, leases, budget, and approvals; a provider cannot change them. SDK internal retries must be zero.

OpenAI configuration is through environment variables: `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_EDIT_MODEL`, and `OPENAI_IMAGE_RESERVATION_USD`. Secrets are never persisted in receipts. Defaults use dated verified model snapshots. The adapter checks model visibility on health probe and before first use of each configured model. A provider health result deliberately separates availability from a live generation test.

Oracle configuration uses `ORACLE_ENABLED=true`, optional `ORACLE_MCP_COMMAND`, optional JSON array `ORACLE_MCP_ARGS`, and `ORACLE_HOME_DIR`. The default process is `oracle-mcp`; the application does not download or update it automatically. Its receipts record session IDs and unmetered subscription use without claiming the service was free. It is for attended use, never a default unattended fallback.

To add capabilities, extend the documented profile and add tests for refused unsupported operations, reference handling, uncertain outcomes, secrets redaction, and result ingestion. To add a model, first inspect its official contract and sizes, then add its explicit capability profile. The current verified profile intentionally permits only the documented GPT Image 2.5 models.

The optional remote Batch methods are lower-level provider methods. Callers must persist a pre-submission attempt, retain the returned batch ID, poll by ID, and handle partial success. Cancellation does not erase already billed completed work. Default queue orchestration remains per image, allowing local leases, review and revisions to share one path.


`configuration()` returns a JSON-safe, nonsecret provider descriptor. `providerConfiguration()` includes capabilities and canonicalizes the descriptor for hashing. A batch stores this snapshot with its budget approval; the worker checks the hash before calling a provider and fails closed on drift. Models, quality, reservation and plugin versions belong in the snapshot; API keys never do. Oracle hashes command/argument configuration without exposing the underlying values. External browser model changes remain an attended operator responsibility.

Provider results are runtime validated before accounting. Nonfinite or negative cost, missing provider/model/path, or missing mock identity causes reconciliation with the existing reservation retained. This protects the ledger from faulty third-party plugins.

Legacy external execution batches without a provider configuration hash fail closed and require a new approved plan/budget. Previously completed outputs remain inspectable.
