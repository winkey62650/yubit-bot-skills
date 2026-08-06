export const DEFAULT_LOCALE = "zh-CN";

export function normalizeLocale(locale) {
  const value = String(locale || "").toLowerCase();
  if (value === "en" || value.startsWith("en-")) return "en";
  if (value === "zh-cn" || value.startsWith("zh-")) return "zh-CN";
  return DEFAULT_LOCALE;
}

export const messages = {
  "zh-CN": {
    "nav.analytics": "网站数据", "nav.distribution": "内容分发中心", "nav.composer": "手动消息发布",
    "nav.groups": "群与 Topic", "nav.newGroup": "新群初始化", "nav.discord": "Discord 社区",
    "nav.trading": "交易中心", "nav.publisherStatus": "发布账号状态检测", "nav.capabilities": "后台能力", "nav.settings": "系统设置",
    "common.logout": "退出登录", "common.loggingOut": "正在退出…", "common.loading": "加载中...", "common.refresh": "刷新运行状态",
    "common.refreshing": "正在核验", "common.delete": "删除", "common.moveUp": "上移", "common.moveDown": "下移",
    "login.title": "YUBIT 后台", "login.subtitle": "登录后管理内容发布与群运营", "login.username": "账号", "login.password": "密码",
    "login.submit": "登录后台", "login.submitting": "正在登录…", "login.failed": "登录失败，请稍后重试",
    "login.notice": "会话会在 12 小时后自动失效，请勿在公共电脑保存密码。",
    "composer.title": "消息发布中心", "composer.desc": "选择账号和目标，编写消息并发送或加入队列。",
    "composer.account": "发送账号", "composer.accountPlaceholder": "-- 请选择账号 --", "composer.noAccount": "暂无已授权账号，请联系管理员添加。",
    "composer.body": "消息正文（支持 Markdown）", "composer.bodyPlaceholder": "请输入消息内容...", "composer.media": "附加媒体 / 文件（支持多选）",
    "composer.mediaHint": "可选择多张图片/视频作为组图发送。文本将作为整体 Caption 附在下方。",
    "composer.send": "立即发送", "composer.queue": "加入队列", "composer.processing": "处理中...", "composer.targets": "当前账号可发言的群组/频道",
    "composer.manageGroups": "群组管理页", "composer.loadingTargets": "正在读取当前账号的发言权限...", "composer.noTargets": "当前账号暂无可发言目标",
    "composer.noTargetsHint": "这里只显示所选账号能够真实发言的群组和频道。请检查该账号是否已加入并获得发言权限。",
    "composer.selectAll": "全选（包括所有 Topics 和频道）", "composer.selectionHint": "切换发送账号会重新读取权限并清空旧选择。当前已选择：{count} 个目标",
    "composer.selectAccountError": "请选择发送账号", "composer.selectTargetError": "请选择发送目标", "composer.contentError": "请输入消息内容或选择附件",
    "composer.dialogError": "读取账号可发言频道失败", "composer.sendError": "发送失败", "composer.sent": "消息发送成功", "composer.queued": "消息已加入队列",
    "publisher.title": "发布账号状态检测", "publisher.desc": "查看真人 Telegram 发布账号、发布桥和已授权目标的实时状态。",
    "publisher.openComposer": "进入发布中心", "publisher.accounts": "已授权账号", "publisher.bridge": "本机发布桥", "publisher.targets": "已授权目标",
    "publisher.fallback": "安全回退", "publisher.noAnonymous": "禁止匿名", "publisher.readonly": "此账号仅可查看状态和手动发布消息；Telegram 授权由管理员维护。",
    "publisher.none": "暂无已授权的 Telegram 账号。", "publisher.online": "在线", "publisher.offline": "离线", "publisher.publishing": "正在发布",
    "publisher.stalled": "任务卡住", "publisher.degraded": "最近发布失败", "publisher.count": "{count} 个",
    "publisher.loadError": "获取授权信息失败", "publisher.statusError": "发布账号状态检测失败",
    "publisher.healthPending": "发布闭环需要处理：请等待本机发布桥、Telegram 会话和目标白名单全部恢复。",
    "role.manual": "手动发布专员", "help.title": "帮助与支持", "help.desc": "使用文档 / 常见问题"
  },
  en: {
    "nav.analytics": "Site Analytics", "nav.distribution": "Distribution Center", "nav.composer": "Manual Publishing",
    "nav.groups": "Groups & Topics", "nav.newGroup": "New Group Setup", "nav.discord": "Discord Community",
    "nav.trading": "Trading Center", "nav.publisherStatus": "Publisher Status", "nav.capabilities": "Capabilities", "nav.settings": "System Settings",
    "common.logout": "Log out", "common.loggingOut": "Logging out…", "common.loading": "Loading...", "common.refresh": "Refresh status",
    "common.refreshing": "Checking", "common.delete": "Delete", "common.moveUp": "Move up", "common.moveDown": "Move down",
    "login.title": "YUBIT Console", "login.subtitle": "Manage publishing and community operations", "login.username": "Username", "login.password": "Password",
    "login.submit": "Sign in", "login.submitting": "Signing in…", "login.failed": "Sign-in failed. Please try again later.",
    "login.notice": "Sessions expire after 12 hours. Do not save your password on a shared computer.",
    "composer.title": "Message Publishing Center", "composer.desc": "Choose an account and destinations, then send now or add to the queue.",
    "composer.account": "Publishing account", "composer.accountPlaceholder": "-- Select an account --", "composer.noAccount": "No authorized account. Contact an administrator to add one.",
    "composer.body": "Message (Markdown supported)", "composer.bodyPlaceholder": "Enter your message...", "composer.media": "Media / files (multiple allowed)",
    "composer.mediaHint": "Select multiple images or videos as an album. The text will be used as the caption.",
    "composer.send": "Send now", "composer.queue": "Add to queue", "composer.processing": "Processing...", "composer.targets": "Groups/channels available to this account",
    "composer.manageGroups": "Manage groups", "composer.loadingTargets": "Checking destinations this account can post to...", "composer.noTargets": "No available destinations",
    "composer.noTargetsHint": "Only groups and channels where the selected account can actually post are shown. Check membership and posting permissions.",
    "composer.selectAll": "Select all (all Topics and channels)", "composer.selectionHint": "Changing the account refreshes permissions and clears selections. Selected: {count}",
    "composer.selectAccountError": "Select a publishing account", "composer.selectTargetError": "Select at least one destination", "composer.contentError": "Enter a message or select an attachment",
    "composer.dialogError": "Unable to load available destinations", "composer.sendError": "Send failed", "composer.sent": "Message sent", "composer.queued": "Message added to queue",
    "publisher.title": "Publisher Status", "publisher.desc": "View the live status of human Telegram accounts, the publishing bridge, and authorized destinations.",
    "publisher.openComposer": "Open publishing center", "publisher.accounts": "Authorized accounts", "publisher.bridge": "Local publishing bridge", "publisher.targets": "Authorized destinations",
    "publisher.fallback": "Safe fallback", "publisher.noAnonymous": "Anonymous blocked", "publisher.readonly": "This account can only view status and publish manually. Telegram authorizations are managed by an administrator.",
    "publisher.none": "No authorized Telegram account.", "publisher.online": "Online", "publisher.offline": "Offline", "publisher.publishing": "Publishing",
    "publisher.stalled": "Job stalled", "publisher.degraded": "Recent failure", "publisher.count": "{count}",
    "publisher.loadError": "Unable to load authorization details", "publisher.statusError": "Unable to check publisher status",
    "publisher.healthPending": "Publishing requires attention: restore the local bridge, Telegram session, and destination allowlist.",
    "role.manual": "Manual publisher", "help.title": "Help & Support", "help.desc": "Documentation / FAQ"
  }
};

export function translate(locale, key, values = {}) {
  const normalized = normalizeLocale(locale);
  const template = messages[normalized]?.[key] ?? messages[DEFAULT_LOCALE]?.[key] ?? key;
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
}
