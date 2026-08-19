# 自动市场内容模板优化设计

## 目标与范围

将现有自动发布中的“Crypto News”和“Daily Events”升级为三类固定英文内容模板：

- `Crypto Daily`：每日三条重要 Crypto 新闻。
- `Crypto & Macro Calendar`：每周重点宏观与 Crypto 数据日历。
- `Data Release Updates`：重点数据公布后同步 Actual / Forecast / Previous、市场影响与即时行情反应。

后台管理界面继续使用中文，Telegram 与 Discord 使用同一套内容生成、频道配置、CTA 拼接和发送状态语义。保留现有 `Daily Analysis`、`Whale Signals` 和其他无关自动任务。

本次不引入付费数据源，不根据未经验证的社交媒体消息自动发布，不把 CTA 细分到 Topic。CTA 仍按 Telegram Group / Discord Channel 保存一份，在实际发送前按目标频道读取并追加。

## 设计原则

- **可验证优先**：事实、数值与时间必须能追溯到数据源，不允许模型补全缺失字段。
- **失败时不发布**：关键数据缺失、来源冲突、事件已过期或内容未通过结构校验时跳过发送并记录原因。
- **跨平台一致**：内容语义一致，渲染器分别适配 Telegram HTML 与 Discord Markdown，避免把 Markdown 原文直接显示给用户。
- **配置与运行闭环**：后台保存、重新加载、预览、定时执行和手动执行使用同一份持久化配置与内容管线。
- **安全上线**：预览和测试默认不向真实群组发送；真实发送必须沿用现有启用状态、目标验证和发布门禁。

## 数据来源策略

采用“聚合数据 + 官方来源复核”的混合方案。

### 宏观事件与数据

- TradingView Economic Calendar：提供统一的事件时间、重要性以及 Actual / Forecast / Previous 字段。
- BLS：复核 CPI、PPI、就业、失业率等美国劳工数据的发布时间和公布值。
- BEA：复核 GDP、PCE 等数据的发布时间和公布值。
- Federal Reserve：复核 FOMC 会议时间、利率决议与声明。

聚合源负责及时发现和统一字段；官方源负责校验时间与实际值。首版允许没有官方机器可读值的事件仅使用聚合源，但必须保留来源标识。聚合值与官方值冲突时不得发布，并在后台显示冲突详情。

### Crypto 新闻与事件

来源按可靠性分层：

1. SEC、其他监管机构、项目官方博客、官方公告、官方 GitHub Release。
2. 已配置的行业媒体 RSS，用于发现候选事件。
3. 行情与链上数据只作为影响判断的辅助证据，不替代事实来源。

行业媒体内容必须去重，并优先替换为对应官方原始链接。首版不接入免费 CoinMarketCal 作为实时生产来源，也不自动采集无法验证的 Token Unlock 消息；后续只有在授权条款、实时性和可追溯性满足要求后才扩展。

### 行情反应

- BTC、ETH：优先 Binance，失败时回退 OKX。
- DXY：作为可选项；来源不可用时省略该行并记录降级，不阻断消息发布。
- 变化基准：事件公布前一分钟的最后有效价格，与生成快讯时的最新价格比较。

所有来源请求设置超时、有限重试和来源标识。运行日志记录请求时间、来源、响应状态、数据新鲜度和降级路径。

## 模板一：Crypto Daily

### 调度

- 每天 `08:00 UTC` 执行。
- 候选窗口默认取最近 24 小时。
- 同一事实由多个来源报道时只保留一条。

### 选题和排序

固定输出三个栏目：

1. `BTC ETF / Institutional`
2. `Regulation`
3. `Market / Project`

候选内容按来源可靠性、事件影响、时效性和跨来源确认数量综合排序。每个栏目最多选择一条。没有满足最低可信度的内容时，固定输出 `No material verified update in the last 24 hours.`，影响标记为 Neutral，不用其他栏目的新闻填充。

### 输出结构

```text
📰 Crypto Daily — Aug 17

1️⃣ BTC ETF / Institutional
<verified headline or concise fact>
Market Impact: 🟢 Bullish / 🟡 Neutral / 🔴 Bearish
<one-sentence rationale>
Source: <link>

2️⃣ Regulation
...

3️⃣ Market / Project
...
```

影响判断必须引用可解释规则或事实，例如净流入、监管批准、执法限制或重大安全事件。证据不足时使用 Neutral，不以语言模型主观猜测方向。

## 模板二：Crypto & Macro Calendar

### 调度

- 每周一 `00:30 UTC` 执行。
- 覆盖当前 UTC 周一至周日。
- 事件时间统一显示 UTC；来源只给日期而没有具体时间时显示 `TBD`，不得猜测。

### 事件范围

- 宏观：只保留高重要性事件，以及后台重点数据白名单中的事件。
- Crypto：只保留监管机构、交易所或项目官方来源明确给出时间的重大事件。
- 合并规则：同一事件的名称、国家/资产、公布时间一致时合并来源，不重复展示。

### 输出结构

为避免 Telegram 与 Discord 对 Markdown 表格的支持差异，按日期使用文本块而不是宽表格：

```text
📅 Crypto & Macro Calendar — Aug 17–23
All times UTC

MON · AUG 17
12:30 — US CPI YoY
Importance: 🔴 High
Previous: 2.9% · Forecast: 2.8%
Source: BLS / TradingView

WED · AUG 19
18:00 — FOMC Minutes
Importance: 🔴 High
Source: Federal Reserve
```

Forecast 或 Previous 缺失时省略对应字段，不展示 `null`、空字符串或推测值。

## 模板三：Data Release Updates

### 事件驱动调度

该模板不是普通固定 Cron。系统从已生成的周历建立待监控事件：

- 公布前 5 分钟进入监控窗口。
- 每分钟查询一次，直到公布后 15 分钟。
- 检测到新的非空 Actual 后生成一次快讯。
- 去重键为 `source event id + scheduled time + normalized actual`。
- 窗口结束仍无 Actual 时不发送，并记录超时状态。

目标是公布后 1–3 分钟发布，但这是服务目标而非伪造数据的理由。来源尚未更新时继续等待，绝不沿用旧值。

### 首版重点数据白名单

- CPI / Core CPI
- PCE / Core PCE
- Nonfarm Payrolls
- Unemployment Rate
- Average Hourly Earnings
- FOMC Rate Decision / Statement
- GDP
- PPI
- Retail Sales
- Initial Jobless Claims

FOMC 声明等非数值事件使用专用结构，不强行生成 Actual / Forecast / Previous。

### 影响判断

影响方向由指标规则引擎产生，而不是自由文本猜测：

- 通胀类：结合 Actual 与 Forecast 的偏差判断对风险资产的边际影响。
- 就业类：结合非农、失业率和薪资组合判断；信号冲突时为 Neutral。
- 增长类：结合 GDP 或零售销售的方向与幅度，明确“增长利好”和“利率预期压力”可能冲突。
- FOMC：按利率结果与可验证声明变化判断；无法结构化确认时为 Neutral。

每条结论同时生成一句英文解释。规则置信度不足或关键字段缺失时使用 `🟡 Neutral`。

### 输出结构

```text
🚨 US CPI Released

CPI YoY
Actual: 2.7%
Forecast: 2.8%
Previous: 2.9%

Core CPI YoY
Actual: 2.8%
Forecast: 2.9%
Previous: 3.0%

📊 Market Impact: 🟢 Bullish for Risk Assets
Inflation came in below expectations, increasing expectations for a more dovish Fed path.

BTC: +1.2%
ETH: +1.5%
DXY: -0.4%

Source: BLS / TradingView
```

## 后台管理设计

自动发布页面将旧卡片替换为：

- `每日 Crypto 新闻`，展示“每天 08:00 UTC”。
- `每周数据日历`，展示“每周一 00:30 UTC”。
- `数据公布快讯`，展示“事件驱动，每分钟检查”。

三类规则保留现有目标选择、启停和最近运行状态，并增加：

- 内容结构预览。
- 来源健康状态和最后成功更新时间。
- 本次候选数、入选数、缺失字段与冲突提示。
- 跳过发送的明确原因。
- 下一次固定执行时间，或下一场待监控事件。

“立即测试”只执行完整生成与渲染流程并返回预览，不调用 Telegram 或 Discord 发送接口。需要真实发送的操作必须使用单独且明确的入口，并展示目标频道、Topic、CTA 预览和二次确认。

## Telegram、Discord 与 CTA

内容生成层输出平台无关的结构化文档，由平台渲染器分别转换：

- Telegram 使用受支持的 HTML 标签并正确转义动态文本。
- Discord 使用受支持的 Markdown，并避免 Telegram 专属语法。
- URL 在结构化层保存为链接节点，不把未经转义的 Markdown 字符串拼接进正文。

CTA 按 Telegram Group 或 Discord Channel 保存一份富文本，不按 Topic 重复配置。实际发送流程在确定目标后读取频道当前 CTA，渲染为对应平台格式，再追加到正文。CTA 为空时不增加额外分隔符。保存、重新打开后台、预览、手动发布和自动发布必须读取同一个持久化字段。

## 配置迁移

- 旧 `news` 规则迁移为 `crypto-daily`，保留启用状态、目标频道、Topic 和其他投递设置。
- 旧 `daily-events` 规则迁移为 `weekly-calendar`，同样保留投递设置。
- 为每条迁移后的周历规则建立对应的 `data-release-updates` 规则，复制目标但默认关闭，防止上线后意外向生产群发送。
- 迁移具有幂等性；重复部署不得创建重复规则或重复频道记录。
- 已退出或不存在的频道不因迁移重新创建，目标验证失败时将规则标记为需要处理。

## 服务与数据模型

内容生成器返回统一结果：

```json
{
  "templateId": "crypto-daily",
  "generatedAt": "2026-08-19T08:00:00Z",
  "document": [],
  "sources": [],
  "warnings": [],
  "deduplicationKey": "...",
  "publishable": true
}
```

自动执行、后台预览和手动测试共同调用该生成器。发布服务只接受 `publishable: true` 且通过平台渲染校验的结果。运行记录保存模板版本、目标、来源摘要、去重键、生成结果、发送结果和跳过原因，便于从后台定位“配置已保存但发送内容未生效”的问题。

## 错误处理与可观测性

- 来源超时：尝试已定义的回退来源；无回退则跳过受影响内容。
- 字段缺失：省略非关键字段；Actual 等关键字段缺失时不发快讯。
- 来源冲突：不自动选择较有利的值，停止发送并显示双方数据。
- 渲染失败：不降级为未经解析的 Markdown，记录平台、节点和错误。
- 发送失败：沿用有限重试与去重键，避免超时重试造成重复消息。
- 频道失效：禁用该目标并提示，不自动恢复已退出的 demo/test 频道记录。

后台运行日志至少显示生成耗时、发布时间延迟、来源状态、降级次数、跳过原因和各平台发送结果。

## 测试策略

### 单元测试

- 三类模板结构、空栏目和字段省略。
- 新闻分类、排序、跨来源去重与官方链接替换。
- UTC 周区间、夏令时来源转换、TBD 时间处理。
- Actual / Forecast / Previous 解析、单位归一化和来源冲突。
- 重点指标影响规则和 Neutral 回退。
- 事件监控窗口、去重键和重复轮询。
- Telegram HTML、Discord Markdown、动态字符转义和频道 CTA 拼接。

### 集成测试

- 后台保存后重新加载，配置、目标和 CTA 不丢失。
- 预览、手动测试和自动任务使用同一生成管线。
- 旧规则迁移保持目标且不创建重复频道。
- Binance 失败时切换 OKX，DXY 失败时按预期降级。
- 数据源超时、冲突和过期时不会调用真实发送器。

### 发布门禁

- 全量测试通过。
- 使用固定 Fixture 完成 TG/DC 快照测试。
- 生产环境仅执行只读来源健康检查与预览。
- 核对迁移后的规则数量、目标和默认启用状态。
- 未经用户明确批准，不向生产 Telegram 或 Discord 频道发送测试消息。

## 发布与回滚

实现完成后依次执行：

1. 本地测试与构建。
2. 提交并推送 GitHub `code/academy` 分支。
3. 备份生产配置和规则数据。
4. 部署生产并执行幂等迁移。
5. 执行来源健康检查、后台保存/重新加载验证和三类模板预览。
6. 检查现有 Daily Analysis、Whale Signals、手动发布和 CTA 回归结果。

回滚时恢复上一版本应用，并保留新增规则和运行日志以便排查；旧规则映射在确认新版本稳定前不物理删除。数据迁移必须支持旧版本忽略新增字段。

## 验收标准

- 后台显示三类新模板，旧两类模板不再作为可新建选项。
- 每日新闻固定三栏且只使用可追溯内容。
- 周历按 UTC 周范围展示，TG/DC 均无表格错位或 Markdown 原文泄漏。
- 重点数据在来源更新后只生成一次快讯，字段与来源一致。
- 配置保存、页面重载、预览、手动执行和自动执行结果一致。
- CTA 按频道读取并在 TG/DC 正确渲染，Topic 不产生重复配置。
- 数据缺失、冲突或来源不可用时不发布错误内容，并可从后台看到原因。
- GitHub 与生产环境版本一致，生产验证不产生未经批准的真实消息。
