# CreativeEngine P8–P10 release index

Tested code: `bf18ba8b919e33f08a68749380c474c40a21c621` on `codex/p8-p10-creative-engine`. Baseline: `93102c2725b3942ca924ec0115224fa65bcb13d5`. Final document commit is the Git commit containing this index; it changes reports and task metadata only. The coordinator maintains the unified three-repository release index and 73-ID audit.

- [Acceptance mapping](acceptance-results.json), [capabilities](CAPABILITY_STATUS.md), [Go/No-Go](GO_NO_GO.md)
- [P8](P8_REPORT.md), [P9](P9_REPORT.md), [P10](P10_REPORT.md)
- [Operations](OPERATIONS.md), [security review](SECURITY_REVIEW.md), [independent agent review](INDEPENDENT_REVIEW.md)
- [Release notes](RELEASE_NOTES.md), [remaining limitations](KNOWN_LIMITATIONS.md), [billing preparation](billing-reconciliation-template.json)
- [Final 52-test suite](evidence/final-regressions/result.json), [typecheck](evidence/final-typecheck/result.json), [build](evidence/final-build/result.json)
- [TradeCase HTTP provider contract](evidence/final-contract-tc/result.json), [LaunchCase HTTP provider contract](evidence/final-contract-lc/result.json), [contract checker negatives](evidence/final-contract-verifier/result.json)
- [Real browser execution](evidence/final-browser/result.json), [hashed desktop/mobile renders](evidence/studio/render-manifest.json), [local TLS](evidence/final-https/result.json), [evaluation CLI](evidence/final-evaluation-cli/result.json)

Every final command is paired with its safe synthetic output.log and log SHA. Precommit logs retain failed experiments, subsequent repairs and source dirtiness; only `final-*` evidence is bound to the implementation SHA above. Fresh paid APIs, private data, actual billing, real human quality/business acceptance and production are BLOCKED_EXTERNAL; no such execution is implied by this release.
