# Architecture and invariants

All entrypoints (local REST, Studio, CLI, MCP and TradeCase adapter) invoke `Core`. SQLite stores immutable input snapshots, jobs, attempts, assets, reviews, exports and an append-only event stream. Worker scheduling uses WAL, busy timeout, `BEGIN IMMEDIATE`, leased tasks with fencing by attempt and worker identity, heartbeats, bounded retries, and durable receipts.

## Production sequence

Create project → import authorized evidence and raster assets → snapshot confirmed product facts → write brief → deterministic Planner selects a versioned Skill and strategy → inspect frozen plan → authorize budget → expand scenes × variants → worker → image/QA receipts → immutable output → machine checks → human review → approved ZIP with manifest.

Planner is currently a deterministic policy planner and direction generator. It does not pretend to semantically understand arbitrary natural-language product requests. Structured constraints are authoritative. Prompt Compiler combines the frozen Skill template, explicit brief, task direction, constraints, and revision request. No generic autonomous agent loop is used.

## Policy boundary

- Existing SKU and Listing strict fidelity: reuse/compose only. Original subject is contained, never cropped or regenerated. Concept exploration must be identified as a concept product.
- Controlled tint requires an actual transparent cutout; other supported customizations use reference editing. All controlled/generated outputs are labeled Concept deterministically. A logo tile does not claim physically verified production placement.
- Product Truth snapshots are immutable and cite versioned original evidence. Generated images and Vision observations cannot become factual evidence. Only verified external-cleared facts can become outward claims.
- Every output awaits explicit human review, including outputs whose file checks pass. QA `block` cannot be overridden by review. Only approved outputs are included by default in an export; explicitly requested unapproved outputs reject the request.
- Providers declare capabilities. Missing credentials, unsupported models/sizes, and uncertain remote outcomes are explicit errors. There is no silent provider fallback.

## Persistence and recovery

Task claims and budget reservations commit together before calling a provider. Each external invocation has its own attempt ID. Files and provider receipts are written before the asset becomes available. On expiration, a worker first reconciles persisted receipts. Definite local interrupted tasks can retry up to three times; ambiguous paid requests retain their reservation and enter `reconciling`, without a new paid request. Operator evidence is needed to resolve an outcome without a receipt.

Base+variants waits for a base output and edits from its parent. Revision creates a new plan/batch/task linked to the prior image, preserving prior review records. Deterministic revision supports explicit authorized background colors and cutout colors; unsupported free-text changes return a request for more input.

SQLite and filesystem cannot share a transaction. Crash-created orphan files may remain, but they never become exportable without a committed asset/QA/review chain. Physical edits by the OS user are detected by source/output SHA-256 validation. This is a single-user local service, not a multi-tenant authorization system.

## Deliberate implementation choices

Node 24+ built-in SQLite replaces the suggested ORM. React/Vite and CSS variables implement Studio without a styling framework. Root pnpm workspace locks all dependency versions; source imports share contracts directly. Remote OpenAI Batch submission/polling is implemented at Provider protocol level; normal production queues currently dispatch individual calls for per-task recovery. Remote Batch scheduling is not silently substituted for local queue execution.

Skill input schemas, defaults, prompt and QA rules are frozen together. New safe-slug Skill directories are discoverable without changing core enums; their normalized input is validated with Ajv and cannot bypass global fidelity or truth constraints. Delivery rules are separate sourced/versioned configuration snapshots; the included custom rule does not claim official marketplace policy. Provider nonsecret model/configuration snapshots are hashed into batch identity and checked immediately before execution; configuration drift fails before any external call.
