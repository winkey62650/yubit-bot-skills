# 交易中心发布门禁记录（2026-07-16）

## 本次范围

- 多 Trader 与 Telegram 数字 ID 管理
- Trader 与多个 YUBIT 只读账户关联
- SpeakerBot 私聊接收 `symbol + orderId`，服务端只读核验后多目标发布
- 订单持续追踪、证据链、逐目标失败重试
- 仅对真实已实现盈利发布一次 PNL 卡片
- 交易日志、Trader 管理、发布目标、系统状态后台页面
- 五分钟订单追踪调度与生产环境安全配置

## 自动化证据

- `npm test`：189/189 通过
- `npm run check`：通过
- `npm run build`：通过，包含 `/trading`、SpeakerBot Webhook、交易管理、追踪和 PNL 图片接口
- Vercel Preview Chrome 1366×768 线上验收：通过登录必填校验、正常登录、交易日志、Trader 管理、发布目标和系统状态；无失败接口、未捕获异常或页面级横向溢出
- 受版本控制文件密钥扫描：未发现 Telegram Bot Token、数据库凭证或私钥
- 关键场景覆盖：重复更新、重复订单、429 重试、单目标失败、并发追踪、盈利/非盈利/歧义 PNL、凭证加密、接口脱敏、受保护管理接口和 UI 可访问性
- Preview 隔离新增覆盖：默认拒绝复用正式 SpeakerBot、仅接受 Preview 专用 Bot/Secret、强制使用当前不可变 Preview URL，并识别指向旧部署的 Webhook
- Preview 数据库隔离新增覆盖：必须显式设置 `PREVIEW_DATABASE_URL`，不会回退复用 Production 的 `DATABASE_URL` 或 `POSTGRES_URL`
- 调度器健康门禁新增覆盖：`CRON_SECRET` 为空时明确标记未配置，不再误报“调度正常”或“上线就绪”
- Preview 调度鉴权新增覆盖：仅读取 `PREVIEW_CRON_SECRET`，不复用 Production `CRON_SECRET`

## 线上配置证据

- Vercel 项目：`yubit-bot-skills-academy`
- `code/academy` 已推送，对应 Vercel Preview 已构建完成并达到 `READY`；未部署或提升到生产环境
- 已创建独立 Preview Neon 数据库并接入 `PREVIEW_DATABASE_URL`；新版代码会主动阻断 Preview 复用 Production 的通用数据库变量
- 旧 Preview 已完成登录和数据库连接验证；新 Preview 默认禁用 SpeakerBot Webhook，不读取正式 SpeakerBot Token
- 已为 Preview 单独配置非空 `PREVIEW_CRON_SECRET`；Production 的 `CRON_SECRET` 仍为空，GitHub Actions 中已存在 `YUBIT_CRON_SECRET`
- GitHub Actions 最近一次正式 `distribution` 调度返回 HTTP 401；已确认根因为 Vercel Production 缺少非空 `CRON_SECRET`，而非应用内部调度失败
- 仓库中不保存 Trader API Key、API Secret、Webhook Secret 或 PNL 签名密钥

## 尚未放行的外部验收

1. Preview 功能与 UI 验收已通过，但当前仍为预览环境，未获得生产发布授权。
2. Preview 系统状态应显示 SpeakerBot 安全禁用；若要做真 Bot 验收，必须另外创建 Preview 专用 Bot、Webhook Secret 和独立测试群，不能复用正式 Bot。
3. 曾在会话中暴露的三个 Telegram Bot Token 必须先在 BotFather 轮换；仅确认环境变量存在不等于确认已轮换。
4. 需要至少一个真实 Trader Telegram 数字 ID 和一个关闭交易/转账/提现权限的 YUBIT 只读 API 账户，才能完成真实订单核验。
5. 真实验收需要完成：私聊提交一笔已成交订单、信号进入指定 Topic、五分钟后状态刷新、盈利订单仅发布一次 PNL、后台证据链完整。
6. Preview 已使用独立 Neon 数据库，但仍不得写入正式 Trader、账户、目标或真实运营数据；验收只使用测试数据。
7. GitHub `YUBIT_CRON_SECRET` 与 Vercel 正式 `CRON_SECRET` 需重新对齐，并以一次成功的手动调度作为证据。

## 放行标准

- 预览部署成功，并重复完成一次 Windows Chrome 1366×768 登录及交易中心四入口测试
- Preview 与 Production 的 Bot 和数据库均完成环境隔离
- 三个 Bot Token 已轮换，SpeakerBot Webhook 状态正常
- YUBIT 账户只读权限验证通过，任何写权限都会被后台拒绝
- 一笔真实订单完成端到端验收且无重复发布
- GitHub 定时任务鉴权恢复后，生产部署的受保护接口、定时任务和 Telegram 发送均返回成功
