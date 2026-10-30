# Reproducible examples

Run `pnpm demo` from the repository root. It creates a separate synthetic project each time and saves IDs and provenance in `.creative-engine/demo/latest.json`. Open the Studio to inspect five batches:

- B2B faithful fixture composition: one product output, original pixels retained.
- Product concept: four scenes × three directions, 12 clearly marked Mock outputs.
- Ecommerce listing: one strict square output with the versioned `custom-square` delivery rule (a user-defined sample, not marketplace policy).
- Marketing: one faithful campaign composition.
- OEM color preview: three controlled cutout color concepts.

The synthetic product is generated deterministically by the example script and explicitly described as a fixture. It is not a real SKU photograph, live AI result or manufacturing evidence. Demonstration reviews are named `OFFLINE TEST HARNESS`, with explicit fixture-only notes; they are not human business approvals.

For editable input structures, see each `skills/*/examples/brief.json`. Use project/source/snapshot IDs from your own project rather than copying example IDs. The Python integration example demonstrates a real REST client and deliberately stops before human review or external delivery.
