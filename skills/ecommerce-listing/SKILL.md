---
name: ecommerce-listing
version: 1.0.0
description: Faithful commerce imagery composed from verified original SKU materials.
---

# Ecommerce Listing

Faithful commerce imagery composed from verified original SKU materials.

## Inputs

- verified original SKU photos or transparent cutouts
- brand rules and authorized logo
- verified product parameters
- target platform and explicit sourced delivery specification

## Method

1. Normalize the brief through CreativeBrief schema and identify the product stage.
2. Resolve original assets and the exact Product Truth snapshot. Missing evidence is a blocker, never a request to invent a similar-looking product.
3. Route through VisualIntentRouter. Existing listing products are always strict. Strict work uses reuse or deterministic composition; controlled edits list every permitted change; concept exploration receives distinct directions.
4. Freeze this Skill version, prompt template and QA profile into the plan. Compile each scene and variant independently, retaining explicit constraints and revision feedback.
5. Execute only after the batch budget and provider capabilities are validated. Models cannot authorize spending or review their own outputs into approval.
6. Apply deterministic file checks and identity labels, then optional Vision QA. A missing Vision service is reported as unverified. All external delivery requires human approval.

## Acceptance

- Existing SKU work is strict and never free-generates the product
- Actual dimensions match requested delivery dimensions
- The product silhouette remains complete and uncropped
- Only verified external-allowed facts appear as labels
- Platform rules are explicit dated configuration, not model inference

## Output

Listing Asset Pack with dimensions, source hashes, QA checks and human approval status.

## Failure and revision

Unauthorized sources, unverified claims, missing SKU evidence and contradictory change rules produce a blocked plan with actionable reasons. A rejected result remains immutable. A targeted revision creates a new child asset and retains the original review, source snapshot and prompt lineage. Concept output cannot update Product Truth.

## Extension

Change the semantic version whenever prompts or QA rules change. New plans capture the new content; previously saved plans execute against their frozen snapshot. The machine manifest, input schema, prompt, QA profile and example in this directory are all part of the Skill contract.
