# Site Nerve 代理站点运营中台

统一收录代理网站，并跟踪 PV、UV、按钮点击率、视频播放率和活跃停留时长。应用由一个 Next.js 服务、一个 SQLite 数据库和一段无依赖追踪脚本组成。

## 本地运行

```bash
npm install
npm run dev -- --hostname 127.0.0.1 --port 3100
```

打开 `http://127.0.0.1:3100`。首次访问会自动创建 `data/agency-analytics.db`，并写入明确标记的演示数据。

## 指标口径

- PV：`page_view` 事件总数。
- UV：访问页面的匿名浏览器 ID 去重数。
- 按钮点击率：发生过按钮点击的会话数 / 页面访问会话数。
- 视频播放率：发生过视频播放的会话数 / 页面访问会话数。
- 平均停留时长：活跃心跳累计时长 / 页面访问会话数。页面不可见或超过 60 秒无交互时不累计。

## 网站接入

在“接入中心”选择网站，将生成的脚本放进代理网站的 `<head>`：

```html
<script defer src="https://analytics.example.com/tracker.js?site=SITE_ID&key=SITE_KEY"></script>
```

脚本会自动识别普通链接、按钮、带 `data-track` 的元素以及 HTML5 视频。建议为核心 CTA 添加稳定名称，例如：

```html
<a data-track="join-vip-hero" href="https://t.me/example">Join VIP</a>
```

## 部署到现有 TG Bot 服务器

部署配置复用服务器的 Node、systemd、Nginx 和 Certbot，不占用 Bot 的 `4174` 端口。本服务使用 `4180`，默认域名是 `analytics.152-32-161-174.sslip.io`。

1. 将当前目录上传到服务器临时目录。
2. 在服务器执行：

```bash
cd /path/to/agency-analytics
ADMIN_PASSWORD='替换成强密码' bash deploy/server/deploy-from-source.sh
```

管理页面和管理 API 由 Nginx Basic Auth 保护；只有 `/tracker.js`、`/api/events` 和健康检查公开。SQLite 数据持久化在 `/var/lib/agency-analytics`，发布新版本不会覆盖历史数据。

## 运维检查

```bash
sudo systemctl status agency-analytics.service
sudo journalctl -u agency-analytics.service -n 100 --no-pager
curl https://analytics.152-32-161-174.sslip.io/api/health
```

生产备份只需定期备份 `/var/lib/agency-analytics`。SQLite 使用 WAL 模式，建议通过 `sqlite3 .backup` 或停服务后复制数据库文件，避免只复制主文件而遗漏 WAL。
