# 未解决问题与下一步边界

- `BLOCKED_EXTERNAL`：实际 API 发票及 Oracle 订阅消耗核验；五次失败的 USD 1.25 预约继续保留。新生成不得复用这些不确定 attempt。
- `BLOCKED_HUMAN_REVIEW`：合成素材仍 pending；accordion 结构要求未完全满足，概念标签重复可见。没有产品事实、设计或完成验收的人工批准。
- `BLOCKED_EXTERNAL`：真实客户/商品资料、真实业务盲评、生产环境及远端写入授权。旧 73 项计划验收不因虚拟案例升级。
- `NOT_LIVE_VALIDATED`：真实编辑/参考素材、多图/持续运行、跨账号或升级 Oracle 版本。固定版本哈希不匹配时拒绝运行。
- `OBSERVED_NOT_ISOLATED`：最终兼容请求组合成功，但单一早期失败根因尚未隔离。禁止宣称“JSON/Medium/ratio 单独导致失败”。
- `PERFORMANCE_UNVERIFIED`：一次并行本地 HTTP 请求超过测试工具 3 秒上限；保留失败和串行复测，未宣称 SLA。
