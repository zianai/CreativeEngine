# Private GitHub publication — 2026-10-30

Direct user authorization: push the new contract CI, create an independent private Creative Engine repository, run both contract gates, and exclude old test collections, credentials and runtime data. No plan upgrade or public visibility change is authorized.

This publication starts a new root commit from local source commit `f0ca0a437f9353c523d7c5bc1409fcf69a9d1c96`. It carries selected application source, Skills/rules, public API examples, dependency manifests/lockfile, necessary documentation and the new Visual Task contract checks. It does not carry ancestors, old tests/, screenshots, verification logs, demos, runtime databases, generated images, or uncommitted live-provider work.

The original main branch and its working files are preserved. Continue GitHub-facing work on `codex/github-private` in the `creative-engine-github` worktree. Do not merge the legacy main history into this branch: cherry-pick reviewed source-only changes or reproduce them as scoped commits, otherwise excluded old data would enter the remote history.

Remote target: `zianai/CreativeEngine`, private, initial branch `main`. Push only the named publication branch; never use --all, --mirror or force push. CI uses only zero-cost fixtures, without OpenAI secrets or mail transports. Initial GitHub Actions completed successfully; see [exact run evidence](GITHUB_CONTRACT_CI_PUBLICATION.md).
