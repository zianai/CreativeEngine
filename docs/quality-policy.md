# Quality and fidelity policy

Quality is evidence, not product truth. Neither generated imagery nor a vision description may add or upgrade a Product Truth fact.

Deterministic checks validate that an image is a regular non-symlink file, bounded in bytes and pixels, decodes as a single-frame PNG/JPEG/WebP, and matches delivery dimensions. Nearly uniform images are flagged for human inspection. Mock identity is always visible in the QA report. Concept previews need a deterministic label and remain explicitly conceptual.

The composer uses contain scaling with no product cropping. Strict processing changes the canvas, not the product's silhouette or structure. Original assets are never overwritten. Logo tiles are separate layers; they do not claim manufacturing placement on a product. Controlled color previews require an actual transparent cutout and a Concept label. Text is escaped before entering the internally generated SVG layer; uploaded SVG files are unsupported.

`inspectImage` returns pass, warn, or block with structured checks and issues. An unconfigured vision reviewer returns `vision.status=skipped`, not a semantic pass. A required missing or invalid vision report blocks. A non-required reviewer failure warns and requires human judgment. Human approval is required for delivery irrespective of the automated score.

`OpenAIVisionReviewer` is a replaceable structured reviewer using the official Responses API. Construction requires explicit authorization and a configured model. The caller must reserve its separate budget before invocation. It compares the candidate against up to three approved references and returns categorized issues, severity, suggested revisions, and uncertainty through a strict Zod schema. Extra properties such as inferred certifications are rejected. The reviewer has no Product Truth write interface. This integration has only local schema/contract tests until an operator authorizes a live review.

Vision cannot establish dimensional accuracy, manufacturing feasibility, authorization, legal certification, or exact product identity. Provenance and deterministic composition supply the strict-fidelity guarantee; humans still review intended use and visible claims. Unknown semantic fidelity must never be reported as verified fidelity.

## Paid review execution and recovery

REST batches opt in with `vision_review: true` and `authorize_paid: true`; the service requires `CREATIVE_VISION_MODEL`, `CREATIVE_VISION_RESERVATION_USD`, `CREATIVE_VISION_INPUT_USD_PER_MILLION`, `CREATIVE_VISION_OUTPUT_USD_PER_MILLION` and an OpenAI key. Rates are operator configuration rather than guessed model pricing. Each task reserves image execution plus semantic review before dispatch. The ledger separates image cost from semantic review cost and labels estimates.

The worker writes a prepared image receipt before review, a durable start marker before the paid call, and a QA receipt before committing database state. Recovery reuses the same prepared image and completed QA receipt. A start marker without a result blocks the task, records conservative estimated review expense, and never repeats the call automatically. A recovery worker maintains its lease during image normalization and semantic review. These paths have injected-provider tests for database failure, unknown review outcome, and competing workers; none of those tests calls a real service.


## Delivery rule snapshots

Plans can capture a versioned delivery rule with a source, date and digest. QA enforces its minimum width/height, accepted raster formats, file-byte ceiling and exact aspect ratio against the actual stored output. Violations block review approval and export. `scope: user_defined` identifies a project delivery requirement; it does not claim official marketplace compliance. The captured rule, rather than a mutable current rule file, governs the historical batch.

A supplied scene image can serve as the deterministic background layer. Only that background is cover-cropped to fit the canvas; the verified product cutout is contained intact. Background and logo source IDs are kept with output provenance. Raster signatures are checked before image decoding, so uploaded or returned SVG/XML is refused without invoking the SVG parser.
