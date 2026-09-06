# Academy 页面与手动发送验收 — 2026-09-06

代码修复及本地回归已完成；线上完整功能验收为 **failed / 未完成**，因为修复尚未部署，且没有执行真实消息投递。页面能打开及接口能返回，不能替代真实发送、授权、初始化、定时发布的业务验收。

- 原始项目：[GitHub code/academy](https://github.com/winkey62650/yubit-bot-skills/tree/code/academy)
- 基线：`fd0643abe0f15ae249257f6a1bc0da3f15de1b5d`，收尾时复查远端未变化。
- 修复分支：`codex/academy-page-audit-20260906`。原工作副本存在的未提交改动未动。
- 当前 owner：Jarvis（本会话完成定位、修复和验证；未另行启动角色 agent）。
- 使用流程：`engineering-quality-router` → `systematic-debugging` → `verification-before-completion`；新增缺陷回归沿用项目 Node 测试与 Playwright。

## 已证实的问题与修复

| 问题 | 证据 | 修复结果 |
| --- | --- | --- |
| 手动目录直接隐藏不可发布的群 | 接口与目录构造函数均过滤 `canSendMessages`；线上配置 6 群，但目录仅返回 1 群、8 Topic | 保留当前账号可见群，禁用不满足权限的目标，并显示发言权限 / 群身份不可用原因。不把其他账号的群配置当作当前账号权限。 |
| 空论坛被当成普通频道 | 浏览器复现其“主页面”复选框可选，而发送校验要求明确 Topic | 保留论坛条目，显示未取得已验证 Topic；不生成无 Topic 的发送目标。 |
| Topic 目录只读取一页 | 模拟服务端短页且总数更多时，旧实现漏掉后续 Topic | 按总数及 Telegram 游标分页，防重复游标；已保存或已选 Topic 另按准确 ID 补查。 |
| 加载失败被隐藏，语言切换重置账号 | 初始加载 catch 只写控制台；账号加载依赖会随语言变化 | 三路请求独立记录失败、可重试；设置读取超时，阻止后台刷新重叠；语言切换保留账号。 |
| 部分发送失败可能重复投递 | 成功 1 个 / 失败 1 个后，两个目标仍被勾选 | 明确成功的目标从选择中移除，保留正文及失败目标；不自动重发。 |
| 公开文章被登录拦截 | 未登录访问两种文章路径最终进入 `/login` | 仅开放严格匹配文章路径的 GET/HEAD；管理 API 继续鉴权。公开页面不请求管理会话。 |
| 目录布局与 Discord 手机表单 | 390px 下 Discord 3 个控件越界；目录栏标题拥挤 | 调整局部网格和最小宽度；三种视口复测无控件裁切。 |

线上“6 群配置、1 群目录”只证明配置与筛选后的列表不同，不能证明其余 5 群全部属于同一权限故障；未加入账号、权限和发布身份的逐群原因，需上线后读取新目录确认。

## 验证结果

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| 语法检查 | passed | `npm run check` |
| 全量自动测试 | 1,323 passed / 0 failed | 使用隔离存储；外部投递由测试替身控制 |
| 生产构建 | passed，exit 0 | 本地生成生产构建；没有上线 |
| 全部 Next 页面与分栏 | 31/31 passed | 25 个实际页面路由，另加 6 个分发分栏；旧入口按既有重定向验证。`.bak` 和旧静态控制台不是当前 Next 入口。 |
| 响应式 | 93/93 passed | 1366、768、390px；无页面异常、无非滚动容器内表单裁切 |
| 手动发送 | passed | 目录展开、权限禁用、两个目标勾选、保存与刷新持久化、文件夹应用、模拟部分失败、账号切换、语言切换、503 恢复。发送请求只到模拟传输，不到 Telegram。 |
| 登录与角色 | passed | 必填、错密、管理员登录、退出、发布员登录、管理 API 403、文件夹接口可用、无队列权限 |
| 公开文章 | passed | 使用独立 QA 内容快照，未登录访问两类文章 200；管理 API 401 |
| 线上页面只读 | 29/29 HTTP 200 | 23 个非参数路由 + 6 个分栏；浏览器异常 0、失败 API 0。参数化文章未使用线上虚构内容代替验证。 |
| 线上核心数据读取 | passed | 文件夹 0、已配置群 6、发布账号 1；分发、Discord、交易、网站数据接口 200；筛选后目录 1 群 / 8 Topic |

本地隔离环境未配置 Telegram 会话、Discord Bot、网站统计后端时，对应接口会明确报错；这些限制保留在 `route-audit.json`。线上相同页面读取已通过，但真实外发与授权写入不在只读检查之内。

浏览器插件的 IAB 后端无法连接，已使用项目现有 Playwright / Chromium 实际浏览器完成上述页面检查，未把构建或静态检查充当浏览器验收。

## 下一阶段与验收门槛

| Owner | 产物 / 动作 | 完成标准 | 时间边界 |
| --- | --- | --- | --- |
| LeiJun（待安排，Jarvis 监督） | 审核本分支差异，部署指定修复版本 | 线上 release 指向修复提交，服务健康，原任务配置保持一致；失败可回滚 | 授权后首个发布窗口 |
| Trump（待安排，Jarvis 监督） | 新目录逐群核对、DEMO 精确 Topic 实发验收 | 能说明目录全部可见项的可用/禁用原因；指定 Topic 收到一次消息，后台返回正确结果 | 部署后同一验收轮 |
| Jarvis | 汇总最终验收 | 代码、测试、构建、线上新版本、实际投递证据齐全后才能改为 passed | 收齐证据后 |

待授权的最小实发验收：仅 DEMO Academy 的 Market Events（thread 8），以已配置群身份发送 1 条纯文字：

> QA｜Academy 手动发送验收｜2026-09-06
>
> 用于确认目录选择与指定 Topic 投递一致，无运营内容。

真实投递前必须核验自动绑定不会扩散到其他目标；若存在扩散规则，先给出最小隔离方案。不得绕过发送身份、白名单或 Topic 权限。图片/视频/文件、多目标部分失败、队列调度、Discord 实发、群初始化及授权变更，仍需各自适用的外部环境和验收授权；本报告不保证未经执行的功能已经全部可用。

## 本次复盘与可复用检查规则

预期是定位目录并验证页面；实际除目录缺陷外，发现公开文章拦截、部分失败重试和手机布局问题。根因是目录展示、实际权限、分页结果及发送结果之间缺少跨层验收。原有 1,319 项测试未覆盖这些浏览器流程。

新增规则：目录必须分别验证“可见、可选择、可送达”；任何列表分页必须覆盖短页和旧 ID；每次发送修复必须检查部分成功后的重试选择；页面发布前覆盖 3 种视口及公开/管理访问边界。耗时点是浏览器插件连接和本地循环地址规范化，已在测试中使用可重复的 Chromium 流程，并在登录跳转测试统一使用 localhost。后续直接运行本目录引用的脚本，先取得可复现失败再改代码。

## 可重复执行

在独立目录启动测试后台，使用合成账号、`.runtime-audit` 存储，不加载生产环境文件：

```sh
AUTH_SECRET=academy-isolated-local-audit-secret AUTH_USERNAME=audit AUTH_PASSWORD=local-audit-only MANUAL_PUBLISHER_USERNAME=manual-audit MANUAL_PUBLISHER_PASSWORD=manual-local-audit JSON_STORE_DIRECTORY=.runtime-audit APP_BASE_URL=http://localhost:3217 TELEGRAM_DEMO_ONLY=true npm run dev -- --hostname 127.0.0.1 --port 3217
```

另一个终端按顺序运行：

```sh
JSON_STORE_DIRECTORY=.runtime-audit node tests/e2e/seed-editorial-pages.mjs
node tests/e2e/academy-login-roles.mjs
node tests/e2e/academy-pages.mjs
node tests/e2e/academy-route-audit.mjs
```

停止开发服务后运行 `npm run check`、`npm test`、`npm run build`，避免开发与构建同时写入 `.next`。线上只读脚本需显式设置 `ACADEMY_READONLY_URL` 与 `ACADEMY_AUTH_FILE`，不会保存凭据，也会阻断页面发起的写请求。

证据：`verification-summary.json`、`route-audit.json`、`production-readonly.json`、`composer-fixed.png`、`composer-mobile-fixed.png`。
