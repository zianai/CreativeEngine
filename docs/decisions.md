# Implementation decisions

- 2026-10-29: Independent repository in `creative-engine`; no TradeCase source modifications. All entrypoints share one Core service.
- Strict existing-SKU work permits only reuse or deterministic composition of authorized verified sources. Controlled customizations and generated concepts carry a deterministic concept label. Generated output and Vision QA never write Product Truth.
- Default operation is offline, zero-cost mock plus real deterministic image composition. Configured external providers require explicit batch budget and paid authorization; uncertain paid requests enter reconciliation and are not automatically submitted again.
- Node's built-in SQLite with explicit versioned SQL migrations is used instead of adding an ORM; it supports WAL, immediate transactions and persistent task leases directly.
- UI direction is a compact local production workbench; implementation is reviewable and does not claim user design acceptance.
