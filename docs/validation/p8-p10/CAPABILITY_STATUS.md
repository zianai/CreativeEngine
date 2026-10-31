# Capability status

Implementation subject: `git:bf18ba8b919e33f08a68749380c474c40a21c621`.

| Capability | State | Evidence / boundary |
|---|---|---|
| Independent Worker/Provider/QA/Skills, per-image requests | implemented, tested locally | final-regressions (52 tests), existing architecture retained |
| Process-crash safety, receipt hashes, unknown Vision/cost | tested locally with fault provider | real subprocess death; synthetic external outcomes |
| Read-only evaluation, exact scope and grant revalidation | implemented, tested locally | synthetic records; real data remains blocked |
| TradeCase/LaunchCase fixed HTTP 1.0.0 contracts | tested local HTTP | independent fixtures and provider checks; remote CI unrun |
| Local session, safe errors, auth, quota, SSE, operations view | tested local HTTP | one trusted operator; no public/multiuser certification |
| DB/assets/receipts backup and new-directory restore | tested on one machine | complete + unknown-liability fixtures; no foreign-host claim |
| Studio desktop/mobile pending/approved/unknown-cost | runtime rendered, limited a11y checks | design_pending; no human design approval |
| One-shot E2 image harness | implemented, preflight and denied-path tested | real execution BLOCKED_EXTERNAL |
| Paid Vision and genuine product quality calibration | BLOCKED_EXTERNAL | no fresh grant or two real human raters |
| Actual paid bill / commercial cost metrics | BLOCKED_EXTERNAL, actual=null | billing access and invoice required |
| Business pilot and production | HOLD | no real human business acceptance or deployment authority |
