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

- `npm test`：179/179 通过
- `npm run check`：通过
- `npm run build`：通过，包含 `/trading`、SpeakerBot Webhook、交易管理、追踪和 PNL 图片接口
- 本地 Chrome 1366×768 只读浏览器验收：通过登录必填校验、交易日志、Trader 管理、发布目标和系统状态；无失败接口、未捕获异常或页面级横向溢出
- 受版本控制文件密钥扫描：179 个文件，未发现 Telegram Bot Token 或私钥
- 关键场景覆盖：重复更新、重复订单、429 重试、单目标失败、并发追踪、盈利/非盈利/歧义 PNL、凭证加密、接口脱敏、受保护管理接口和 UI 可访问性

## 线上配置证据

- Vercel 项目：`yubit-bot-skills-academy`
- Neon/Postgres：已连接生产与预览环境
- 登录、SpeakerBot、数据库、Cron 以及交易中心新增的三项服务端密钥：均已登记
- Vercel `CRON_SECRET` 与 GitHub `YUBIT_CRON_SECRET`：已同时轮换为同一随机值
- 仓库中不保存 Trader API Key、API Secret、Webhook Secret 或 PNL 签名密钥

## 尚未放行的外部验收

1. 当前分支尚未推送，因此预览和生产部署尚未包含本次交易中心代码。
2. 曾在会话中暴露的三个 Telegram Bot Token 必须先在 BotFather 轮换；仅确认环境变量存在不等于确认已轮换。
3. 需要至少一个真实 Trader Telegram 数字 ID 和一个关闭交易/转账/提现权限的 YUBIT 只读 API 账户，才能完成真实订单核验。
4. 真实验收需要完成：私聊提交一笔已成交订单、信号进入指定 Topic、五分钟后状态刷新、盈利订单仅发布一次 PNL、后台证据链完整。

## 放行标准

- 预览部署成功，并重复完成一次 Windows Chrome 1366×768 登录及交易中心四入口测试
- 三个 Bot Token 已轮换，SpeakerBot Webhook 状态正常
- YUBIT 账户只读权限验证通过，任何写权限都会被后台拒绝
- 一笔真实订单完成端到端验收且无重复发布
- 生产部署后受保护接口、定时任务和 Telegram 发送均返回成功
