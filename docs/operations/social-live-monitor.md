# 社媒直播开播监控

在既有社媒来源上增加 YouTube Live 和 X Spaces 开播提醒，复用每条来源保存的精确 Telegram Topic / Discord Channel。X 视频直播、转播他人 Spaces、预约预告和回放不在本次范围。没有把普通帖子标题中的 Live 字样当成开播证据。

## 配置与运行

在「内容分发中心 → 自动发布 → 代理群信息更新」或 Discord 内容分发中心编辑已有来源，勾选「监控直播开播」，保存后使用既有分发调度。需要仅直播时取消「监控普通帖子」。X Spaces 每 5 分钟检查；YouTube 单来源每 20 分钟检查，多个启用来源按数量延长各自间隔。无需新增 Codex 自动化或重启原有 worker。

YouTube 官方默认每天 100 次 search.list。正常单页搜索时，自动检查合计约 72 次/日，为预览等请求留出余量；实际发现延迟受检查间隔和平台索引更新影响。多页结果、共用项目的其他应用或大量手动检测仍可能消耗剩余额度，配额不足会明确报错。不能承诺默认额度下每 5 分钟发现所有新开播。

- 普通帖子开关 `postMonitoring` 默认 true，显式 false 时不进入帖子抓取或更新队列。来源总「暂停」仍同时停止帖子与直播。仅直播配置为总状态启用、`postMonitoring=false`、`liveMonitoring=true`，不会恢复普通帖子推送。
- 新字段 `liveMonitoring` 默认 false，部署不会自动扩大外发范围。
- YouTube 凭据：服务器设置 `YOUTUBE_API_KEY`，启用 YouTube Data API v3，并确认搜索额度足够。
- X 凭据：复用服务器 `X_BEARER_TOKEN`，其应用必须有读取 Spaces 的权限；普通网页 / RSS 访问能力不能证明 Spaces API 可用。
- 配置 Spaces 凭据后，普通 X 帖子会先尝试官方接口；若凭据缺少帖子权限或余额不足，则回到原有公开主页 / Reader 抓取，并继续校验账号归属。公开来源全部失败仍报错，不生成替代内容。此回退仅用于普通帖子，Spaces 直播不会用公开帖子或标题推断开播。
- 凭据只能进入服务器环境文件 / Secret，不能粘贴进前端来源或仓库。后台仅展示是否就绪。
- 已授权的运维可将凭据保存为本仓库同名 GitHub Actions Secret，执行已有 `Deploy production server` 工作流，选择 `operation=configure-social-live`。流程只更新非空的 X / YouTube 字段、重载 web 服务并检查登录页；不改来源开关、收件人或原 worker。凭据通过 SSH 标准输入传输，不放命令参数或发布包；写入前验证格式并原子替换。Google 凭据后补时也使用同一流程。
- 先点「检测直播状态（不发送）」验证当前账号；接口无直播返回未开播，凭据/额度/平台错误返回失败。
- Telegram 继续使用已配置发布身份和白名单；桌面模式进入既有发布桥。桌面桥不能在 10 分钟内投递时，该提醒过期，不能把排队当成发送成功。

## 去重和恢复

持久身份为平台 + 创作者 ID + 直播 ID + 精确目的地，不含标题、检查时间和来源别名。重复配置、标题改动、重复检查及重启不会重复投递。同场提醒仅发一次；首次开启时若正直播，则提醒当前这场。

发送前持久化占位，通过数据库条件更新阻止并发重复。成功需要平台消息编号；发送超时或回执保存结果不明保留待核对，不自动重发。部分目标成功后，失败目标不会导致已成功目标重发。桌面待发通知在确认下播、暂停来源或移除目标后取消；已开始的发送保留原发送生命周期。

历史直播提醒不可通过普通失败重试按钮重放，避免对已结束直播补发开播通知。待核对时，运营核查目标平台的实际消息及投递记录；不得手动删除去重记录来试发。

## 验收与当前范围

### 2026-09-08 YouTube 凭据接入

YouTube 已在正式环境启用：现有 Wise Advice YouTube 来源保持原账号与原发送目标，`postMonitoring=false`、`liveMonitoring=true`、总状态启用。服务器定时任务于 **2026-09-08 05:19:49 UTC** 自动完成首次检查，结果 `offline`、无提醒；下次检查计划为 05:39:49 UTC。应用版本 `133409b938baa61b1b9c25c31f17c0c758f25a96`，[部署成功记录](https://github.com/winkey62650/yubit-bot-skills/actions/runs/34189950402)。普通帖子继续关闭，两个 X 来源与全部发送目标未变化。

最终生产核验：两个入口 × 三种视口通过，页面真实展示帖子关闭、直播开启，检查前后来源不变。证据见 `docs/qa/social-live-youtube-activation.json`。YouTube 监控运行验收 passed；真实开播与外部送达尚未发生，送达验收仍 failed / 未验证；X API 仍返回 402，整体跨平台监控验收仍 failed。

用户完成 Google Cloud 首次账号确认后，已创建专用项目 `yubit-social-live-monitor`、启用 YouTube Data API v3，并创建 `Yubit YouTube Live Production` Key。Key 限定 `youtube.googleapis.com` 与正式服务器 IP，已保存 GitHub `YOUTUBE_API_KEY` Secret 并经[配置流程](https://github.com/winkey62650/yubit-bot-skills/actions/runs/34189464175)安装成功。正式服务器对现有 Wise Advice YouTube 账号的真实检测返回 HTTP 200、`ok=true`、0 场直播；不是仅判断环境字段非空。临时明文文件已清理，没有开通付费试用。

为在普通帖子保持关闭时启用直播，新增独立帖子开关。两项回归覆盖旧配置兼容、仅直播不会抓取帖子、直播调度仍可运行、总暂停仍有效；全量 1351 项通过，浏览器两个入口 × 三视口通过且验证关闭帖子/开启直播后保存刷新仍保留。首轮自动调度结果已另外核对，见上方激活记录。

### 历史：X 凭据首次接入

用户授权直接补齐凭据后，已在其现有 X 登录下创建专用 `Yubit Social Live Monitor` 项目和应用，原应用凭据没有改动。新 Bearer 已保存到 GitHub Secret 并通过[配置流程](https://github.com/winkey62650/yubit-bot-skills/actions/runs/34188067455)安装到正式服务器。线上 GET 状态确认 X ready=true；两个 X 来源的真实只读检测均返回 HTTP 402。控制台预付余额和免费额度均为零，最低充值 USD 5；充值授权尚未获得，没有付款或自动充值。

Google Cloud 停在账号所有者的首次国家/条款确认，YouTube Key 尚未创建。完整监控验收仍为 **failed**，三个直播开关均保持 false，未实际推送。下一步先完成账号确认与 X 额度准备，再由运维创建/配置 YouTube Key、逐来源确认接口成功，最后启用已核验目标内的直播监控。

当前网页版本为 `f948bdff0c97c5828c152f55f06a07d5dc948bad`；其 YouTube 调度和 X 调度分别显示 20 / 5 分钟（当前来源数量）。运维配置版本 `8f4fdbe` 通过配置模式生效，没有重发网页版本。全量 1349 项回归通过，线上两个入口 × 三种视口检查通过、来源未变化。证据见 `docs/qa/social-live-credential-setup.json`。以下为初版发布历史，凭据状态以本更新为准。

2026-09-08 已完成提供商契约、来源归属、状态分类、凭据错误、持久去重、并发、部分失败、暂停、回执更新和桌面过期测试。两个页面入口在 1366 / 768 / 390px 通过浏览器验证；配置持久化、只读预览、401/403 边界通过。

实际生产来源已只读核对：Jenna X 启用；Wise Advice YouTube 和 Wise Advice X 暂停。沿用保存的启用状态与目标。

发布版本 `e74fc1e2ea890c0f14f12403998d2ed54e61c221` 已推送 `code/academy` 并上线；[正式部署记录](https://github.com/winkey62650/yubit-bot-skills/actions/runs/34182306660) 为 success。全量 1343 项测试、检查、构建通过。正式网站 29 个页面/面板只读检查无页面错误和失败接口；两个直播入口 × 三种视口通过，检查前后来源配置一致。证据见 `docs/qa/social-live-release.json`。

完整运行验收仍为 **failed**：正式服务器缺少 `X_BEARER_TOKEN` 和 `YOUTUBE_API_KEY`；三个真实来源的只读检测分别返回 422 及对应缺失项。GitHub 仓库和 Production 环境的 Secret 名称列表也未发现对应凭据。当前三个来源的直播开关均为 false，尚未开始实际直播监控，没有实际推送测试记录。

下一步由服务器管理员在 `/etc/yubit-academy/production.env` 配置这两项平台凭据并重启 `yubit-academy-web.service` 使其生效。运营在原来源中执行「检测直播状态（不发送）」；只有接口成功确认账号与当前状态后才开启直播开关。继续保留已有暂停状态，启用 Wise Advice 来源须同时检查其原有帖子推送的启用意图。真实开播及已核验目标上的投递回执仍需后续验收。

执行人：Jarvis。单轮边界为代码、隔离验证、部署与线上只读状态检查；真实投递只在既有授权范围和已核验目标内执行。

## 官方依据

- [X 按创作者查询 Spaces](https://docs.x.com/x-api/spaces/get-spaces-by-creator-ids)：按账号获取直播/预约状态，通过 creator_id 校验归属。
- [YouTube 搜索接口](https://developers.google.com/youtube/v3/docs/search/list)：限定频道与 eventType=live。
- [YouTube 配额说明](https://developers.google.com/youtube/v3/getting-started#quota)：默认每天 100 次 search.list。
- [YouTube 视频直播详情](https://developers.google.com/youtube/v3/docs/videos#liveStreamingDetails)：以实际开始时间及是否已结束复核直播状态。

## 本次复盘与流程升级

预期复用社媒帖子链路；实际发现旧链路仅以最新内容 hash 判断更新，缺少直播状态、逐场逐目标去重和延迟投递时效。新能力单独保存直播状态，复用身份/目标/持久投递基础设施。耗时点是本机 HTTPS 客户端连接故障和不完整的浏览器 API 替身。后续验收直接运行 `tests/e2e/academy-social-live.mjs`，复用真实隔离存储；响应式检查沿用既有规则，排除允许横向滚动的导航，检查实际表单控件。

本模块新增门禁：不得用标题或 Feed 新增代替开播证据；不得将平台错误视为未开播；不得在直播提醒过期后重试历史文案；不得把 queued 或未确认回执标为已发送。
