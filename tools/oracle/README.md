# Repository-local Oracle 0.22.2 image repair

This wrapper preserves Oracle's MCP `chatgpt_image` request and response contract.
It loads the installed package through version/hash-pinned Node module hooks; it
does not edit the global installation. It does not authorize generation or grant
business approval. The CE provider must separately validate its live grant and
must treat timeout, interruption, missing artifacts or non-completed status as
unknown, with no automatic retry.

Run the MCP transport with:

```sh
node tools/oracle/entry.mjs --package-root /absolute/path/to/@steipete/oracle --mcp
```

For the original CLI use `--cli` followed by its normal arguments. The wrapper
replaces `NODE_OPTIONS` with its own pinned import hook so Oracle's detached
workers use the same patch. Pass a minimal environment, an isolated
`ORACLE_HOME_DIR`, a nonexistent `DOTENV_CONFIG_PATH`, and the expressly authorized
browser profile. Never inherit API keys for this browser transport. MCP output
paths must stay below `ORACLE_HOME_DIR/generated`; do not enable the external
output-path override.

Runtime fingerprint files are `entry.mjs`, `register.mjs`, `patch.mjs`,
`image-dom.mjs`, and `upstream-pins.json`. The latter pins the installed
`package.json`, `dist/src/browser/index.js` and `dist/src/browser/chatgptImages.js`.
The caller should additionally bind its Node binary, private runtime config,
selected profile identity, and output root in its existing authorization scope.

Oracle's image tool invokes `runConsultTool` without `waitForCompletion`, whose
default is true. The native structured response contains `sessionId`, `status`,
and `images`. Require exact `status: completed` plus valid saved artifact bytes;
do not interpret the absence of an MCP error as completed generation. Own-session
`meta.json` carries `browser.runtime.conversationId` and `chromeTargetId`. Browser
conversation IDs are not native API billing/request receipts, and current-model
selection does not verify a model identity.

The observed defect was reproduced from the existing synthetic image conversation
using read-only CUA inspection. Its image was a loaded same-origin blob inside
`generated-image-preview` / `generated-image-gallery`. The single outer
`data-turn-key` exchange contained nested `data-chatgpt-search-unit-key=...:user`
and `data-content-search-unit-key=...:user`, without an assistant role marker.
Oracle found no `latestUser` because it checked only the old nested role
attribute, then rejected all blob images. The fixture tests reproduce that DOM
structure using synthetic identifiers; they are not a live-generation claim.

The patch:

- Resolves nested modern user aliases, deduplicates them and requires exactly one
  post-submission user. A later request in the same conversation blocks adoption.
- Requires the exact conversation URL, a fresh turn boundary, an image after the
  user, a recognized generation container, loaded dimensions, no visible stop
  control, and a completed turn where that state marker exists.
- Requires two unchanged observations at least 500 ms apart. It carries the same
  conversation boundary into collection and rechecks it before and after download.
- Accepts only same-origin ChatGPT blob/estuary image URLs. Credentials stay in
  browser fetch; redirects and generic download-button fallbacks are disabled.
- Rejects non-raster signatures and artifacts larger than 32 MiB, then publishes
  bytes atomically without overwriting a prior file. CE still performs its own
  image decoding, QA, receipt hashing, and human-review gates.

Offline tests and an MCP dry run require no browser or external request:

```sh
CE_ORACLE_PACKAGE_ROOT=/absolute/path/to/@steipete/oracle \
  node --import ./tools/oracle/register.mjs --test tools/oracle/patch.test.mjs
node tools/oracle/mcp-probe.mjs /absolute/path/to/@steipete/oracle /tmp/probe.json
```

`evidence/` records these checks. Actual synthetic generation must be separately
coordinated after the final runtime fingerprint is pinned. Changing any helper or
pinned upstream file invalidates that fingerprint and requires a fresh grant.
