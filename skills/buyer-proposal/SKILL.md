---
name: buyer-proposal
version: 1.0.0
description: Evidence-based B2B product matching and explicitly authorized OEM previews.
---

# Buyer Proposal

Evidence-based B2B product matching and explicitly authorized OEM previews.

## Inputs

- inquiry summary and buyer requirements
- product identity, stage and immutable truth snapshot
- authorized original product photos or cutouts
- explicitly allowed customizations and authorized buyer logo

## Method

1. Normalize the brief through CreativeBrief schema and identify the product stage.
2. Resolve original assets and the exact Product Truth snapshot. Missing evidence is a blocker, never a request to invent a similar-looking product.
3. Route through VisualIntentRouter. Existing listing products are always strict. Strict work uses reuse or deterministic composition; controlled edits list every permitted change; concept exploration receives distinct directions.
4. Freeze this Skill version, prompt template and QA profile into the plan. Compile each scene and variant independently, retaining explicit constraints and revision feedback.
5. Execute only after the batch budget and provider capabilities are validated. Models cannot authorize spending or review their own outputs into approval.
6. Apply deterministic file checks and identity labels, then optional Vision QA. A missing Vision service is reported as unverified. All external delivery requires human approval.

## Acceptance

- Verified product pixels retain product identity
- Every factual label matches the selected immutable truth snapshot
- Only authorized buyer logos are used
- Customization previews carry a deterministic Concept label
- A human must approve each external asset

## Output

A buyer review asset set suitable for a TradeCase proposal, with provenance and approval status.

## Failure and revision

Unauthorized sources, unverified claims, missing SKU evidence and contradictory change rules produce a blocked plan with actionable reasons. A rejected result remains immutable. A targeted revision creates a new child asset and retains the original review, source snapshot and prompt lineage. Concept output cannot update Product Truth.

## Extension

Change the semantic version whenever prompts or QA rules change. New plans capture the new content; previously saved plans execute against their frozen snapshot. The machine manifest, input schema, prompt, QA profile and example in this directory are all part of the Skill contract.
