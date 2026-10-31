# Existing T014 targeted verification records

No test or external call was executed while preparing this archive.

- `independent-12/` contains the TradeCase reviewer's original 12-case runner result and log, unchanged. This was before the final local-composition marker relocation adjustment.
- `independent-7/` contains the reviewer's final 7 affected local-composition/recovery cases, unchanged. Original result records bind their historical HEAD plus dirty patch; they have not been relabeled as execution at a later commit. The reviewer independently checked the six source/test byte hashes against commit `5ab29d209a3b1b5023d567d6403fd482c1411632`.
- Both independent `output.txt` files are byte-identical mirrors of `output.log`, so logs remain reviewable if the repository's `*.log` ignore rule applies. Original log hashes were verified while copying.
- `implementer-12/` and `implementer-7/` are explicitly identified transcriptions of existing `exec_command` tool output (chunk IDs retained), not newly generated runner logs.
- `typecheck-tool-record.json` reports the original command precisely: no TypeScript diagnostics were observed, and the combined shell returned zero. A standalone TypeScript exit status was not captured; the combined result must not be presented as that stronger evidence.
- `final-source-verification.json` records a read-only comparison with the frozen implementation commit. It is not an execution result.

The 12 cases are new regressions for explicit direction/constraint priority, the single identity label, generated-result spoof protection, native local-composition finish/recovery and corrupted/missing local label records. Only the seven cases affected by the final marker change were repeated. No unaffected prior suite was run. Offline synthetic transport/raster tests are not live model or business acceptance.
