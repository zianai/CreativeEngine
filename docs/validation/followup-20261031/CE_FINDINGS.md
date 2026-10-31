# Native paid image / Vision follow-up

Both image calls used the existing CE Core→Task→Worker→OpenAI provider→receipt→file QA path with fresh pinned scopes and one request per image. Both completed as review_pending. The first output invented numerical dimensions and did not depict foldability. It was rejected by an explicitly named AI engineering-test reviewer; no human approval was asserted. A constrained prompt produced visible hinges without dimensional claims. That candidate remains pending human review.

The actual VisionReviewer independently returned blocking fact-risk and product-identity findings on the first image. This was a separate scoped semantic review, not a retroactive claim that Worker originally ran Vision. The Worker QA record honestly retains its original skipped Vision status. No generated image became SKU evidence.

Actual paid assets were displayed through the local server and Chromium at 1440/390 widths; unapproved/rejected export was denied. A follow-up browser helper initially closed an already-closed database during cleanup; the helper was fixed and both runs completed with exit 0. This was a harness cleanup defect, not another paid request.

A real cost-reporting gap was found: Vision usage contained cache_write_tokens, but the estimator applied the ordinary input tariff. The new cost parser preserves the reservation when that tariff is unavailable, retains raw usage, and rejects invalid counts. Original response records remain unchanged; the correction is explicit in CE_ACTIONS.json. No invoice was retrieved or fabricated. The image usage estimates use the official standard rates checked at https://developers.openai.com/api/docs/pricing : text input $5/M, image input $8/M, image output $30/M. Unknown actual billing remains null.
