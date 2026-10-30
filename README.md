# Creative Engine

本地优先的视觉生产工作台。把业务 Brief、真实产品资产和有来源的事实快照，转成可审核计划、可靠批量任务、版本化图片与批准后的交付包。独立于 TradeCase。

## 启动

要求 Node.js 24+、pnpm 11.26.0。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

打开 http://127.0.0.1:4310。服务默认仅监听本机，并内置持久化 Worker。关闭服务不会丢失任务。需要分进程时使用 `CREATIVE_WORKER=0 pnpm serve` 与 `pnpm worker`，二者指向同一 `CREATIVE_DATA_DIR`。

```bash
pnpm check                # 类型、Visual Task 契约检查、前端构建
pnpm creative doctor      # Provider 配置与能力
pnpm mcp                  # stdio MCP 服务
```

CLI 所有命令支持 JSON 输出，`pnpm creative --help` 查看入口。

## 完成一次生产

1. 创建产品项目，导入真实照片、透明抠图、授权 Logo 和证据文档；分别确认使用权、真实性及敏感信息处理。
2. 保存产品事实快照。每条事实记录来源资产、版本、确认时间与能否用于外部交付。
3. 选择 Buyer Proposal、Product Concept、Ecommerce Listing 或 Marketing Creative Skill，填写业务需求、场景、变体、修改范围与交付用途。
4. 检查生成的 VisualPlan。严格商品保真优先复用/确定性合成；概念探索允许多方向生成。缺证据或越权修改会阻断。
5. 确认计划和预算后执行。Mock 默认零费用；真实模型和可选 Vision QA 需要单独勾选付费授权。
6. 在画廊检查 QA、来源和版本，批准或拒绝。定向返工创建新版本，保留原图与历史审核。
7. 导出批准图片及 Manifest ZIP。外部交付清单只包含允许对外的已验证事实，不泄露内部 Prompt、需求和审核备注。

## 已实现的边界

- API、CLI、MCP、Studio 共用 Core；来源资产、事实快照、Skill 快照、计划、批次、任务、尝试、QA、审核、交付包独立持久化。
- 四种业务 Skill 和可扩展协议；Planner/Prompt Compiler 为确定性的策略与模板实现。复杂自然语言意图仍需用户核对结构化修改范围。
- 复用、确定性合成、参考图编辑、概念生成、阻断；独立批量、基准图派生、定向返工。所有输出必须审核。
- SQLite WAL、原子任务领取、租约心跳、预算预留、幂等提交、暂停/取消、有限退避、收费不明时对账，图像和 QA 收据支持恢复。
- 正式 OpenAI Images 与可选 Batch 协议、Oracle MCP Adapter、明确标记的 Mock。Provider 能力与模型配置按运行时探测，不静默替换。
- 文件 QA 与可选结构化 Vision QA。没有授权的 Vision 模型时明确显示“跳过”，不会宣称已自动验证商品一致性。
- REST OpenAPI、持久化 SSE、Python TradeCase 接入示例、本地数据清理工具和 CI。

严格模式保留原始主体的图像内容，缩放采用 contain。它不把照片中无法看见的结构补画成“真实商品”。Logo 合成是明确的展示贴片，不等于工厂已确认的位置或工艺。概念图添加确定性标签。Mock 图不是实际模型生成或商品事实。

## 真实 Provider 与费用

默认无需任何付费凭据即可运行。设置凭据前阅读 [Provider 配置](docs/provider-development.md) 和 [契约检查说明](docs/tradecase-contract-ci.md)。所有凭据仅通过本地环境配置，禁止入库或提交 Git。真实生成必须由操作人确认预算。请求结果不明会进入 reconciling，不能直接自动再付费。

本仓库已运行本地处理、Mock、模拟远端传输和故障注入测试；**未用真实 OpenAI / Oracle / Vision 服务生成图片**。模型存在、工具协议通过和真实服务生成成功是三种不同证据。Remote Batch 扩展已经实现，但默认 Worker 使用逐图队列；远端 Batch 大规模调度不在默认队列中启用。

预算检查按保守预留额控制新请求；供应商没有每请求美元硬上限时，不能把估算当成发票保证。实际返回 usage 单独记账，缺失 usage 会明确标记估算。绝对账户限额还需供应商账户设置。

## 项目资料

- [架构与恢复不变量](docs/architecture.md)
- [API、CLI 与 MCP](docs/api.md)
- [Skill 开发](docs/skill-development.md)
- [Provider 开发](docs/provider-development.md)
- [质量策略](docs/quality-policy.md)
- [TradeCase 接入](docs/tradecase-integration.md)
- [Visual Task 契约 CI](docs/tradecase-contract-ci.md)
- [发布范围](docs/PRIVATE_PUBLICATION.md)

数据默认保存在 `.creative-engine/`，不进入 Git。导入原文件不覆盖；新图创建新资产。本地服务是受信单用户工具，reviewer 字段用于记录操作者，不是企业身份认证。没有买家邮件、Listing 或广告自动发布功能。

## 私有 GitHub 发布范围

此分支从已提交源码创建独立根提交，未包含旧测试目录、旧截图/验证日志、密钥、运行数据库或图片。保留的测试仅为 `contracts/visual-task/` 与其 HTTP 启动器。原有本地历史及未提交开发工作保留在原分支，不随此次发布。

`pnpm check` 运行类型、真实 HTTP 契约及前端构建；不声称旧测试集随仓库发布。该仓库保持私有，不变更账号套餐或启用强制合并规则。
