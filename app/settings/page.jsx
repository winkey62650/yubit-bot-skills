"use client";

import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";
import { loadWorkspaceState, saveWorkspaceState } from "../../lib/workspace-client";

const defaultSettings = {
  webhook: "",
  frequency: "每 5 分钟",
  alertMode: "异常才推送",
  failureThreshold: "2 次连续失败告警",
  environment: "生产环境",
  status: "暂停"
};

const checks = [
  ["本地控制台", "server.mjs", "http://localhost:4173/admin-group-config.html", "正常"],
  ["新闻脚本", "news-poster.mjs", "npm run news", "正常"],
  ["信号脚本", "run-15m-cycle.mjs", "npm run cycle:15m", "正常"],
  ["新群初始化", "scripts/new-group-setup.mjs", "npm run manage:new-group", "正常"],
  ["Lark 推送", "monitor-health-to-lark.mjs", "npm run monitor:health", "待配置"]
];

export default function SettingsPage() {
  const [settings, setSettings] = useState(defaultSettings);
  const [saveStatus, setSaveStatus] = useState("正在读取云端设置...");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadWorkspaceState("settings")
      .then((saved) => {
        if (saved.state) {
          setSettings({ ...defaultSettings, ...saved.state });
          setSaveStatus(saved.updatedAt ? `已恢复云端设置 · ${new Date(saved.updatedAt).toLocaleString()}` : "已恢复云端设置");
        } else {
          setSaveStatus("尚无云端设置，保存后可在其他设备恢复");
        }
      })
      .catch((error) => setSaveStatus(`读取失败：${error.message}`));
  }, []);

  function update(field, value) {
    setSettings((current) => ({ ...current, [field]: value }));
    setSaveStatus("有未保存的修改");
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveStatus("正在保存到云端...");
    try {
      const saved = await saveWorkspaceState("settings", settings);
      setSettings(saved.state);
      setSaveStatus(`已保存到云端 · ${new Date(saved.updatedAt).toLocaleString()}`);
    } catch (error) {
      setSaveStatus(`保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  const configured = Boolean(settings.webhook) && settings.status === "启用";

  return (
    <ConsoleShell>
      <PageHeader title="系统设置" desc="配置程序健康检查、定时监控和 Lark 告警推送；保存后可在其他设备登录恢复。" />
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-4">
        <MetricBox label="检查频率" value={settings.frequency} sub="可按业务低频调整" />
        <MetricBox label="监控程序" value="5" sub="控制台 / 新闻 / 信号 / 建群 / Lark" />
        <MetricBox label="告警渠道" value="Lark" sub="Webhook 推送" />
        <MetricBox label="当前状态" value={configured ? "已启用" : "待配置"} sub={configured ? "云端设置已就绪" : "填入 Webhook 并启用"} />
      </section>

      <Card className="p-6">
        <h2 className="text-xl font-black">Lark 监控配置</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <Field label="Lark Webhook"><input className={inputClass} type="password" autoComplete="off" value={settings.webhook} onChange={(event) => update("webhook", event.target.value)} placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/..." /></Field>
          <Field label="检查频率"><select className={inputClass} value={settings.frequency} onChange={(event) => update("frequency", event.target.value)}><option>每 5 分钟</option><option>每 15 分钟</option><option>每 30 分钟</option><option>每 1 小时</option></select></Field>
          <Field label="告警模式"><select className={inputClass} value={settings.alertMode} onChange={(event) => update("alertMode", event.target.value)}><option>异常才推送</option><option>每次检查都推送</option><option>每日汇总</option></select></Field>
          <Field label="连续失败阈值"><select className={inputClass} value={settings.failureThreshold} onChange={(event) => update("failureThreshold", event.target.value)}><option>1 次失败立即告警</option><option>2 次连续失败告警</option><option>3 次连续失败告警</option></select></Field>
          <Field label="监控环境"><select className={inputClass} value={settings.environment} onChange={(event) => update("environment", event.target.value)}><option>本地控制台</option><option>生产环境</option><option>全部环境</option></select></Field>
          <Field label="状态"><select className={inputClass} value={settings.status} onChange={(event) => update("status", event.target.value)}><option>启用</option><option>暂停</option></select></Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button className="rounded-lg bg-ops-accent px-5 py-3 text-sm font-black text-white disabled:opacity-60" disabled={saving} onClick={save} type="button">{saving ? "保存中..." : "保存设置"}</button>
          <span className="text-xs font-bold text-ops-accent">{saveStatus}</span>
        </div>
      </Card>

      <Card className="mt-5 overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">程序健康检查</h2>
          <p className="mt-1 text-sm text-ops-muted">定时检查脚本是否可运行、控制台是否可访问，并把结果发到 Lark。</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">项目</th><th className="px-5 py-3">检查对象</th><th className="px-5 py-3">检查方式</th><th className="px-5 py-3">状态</th></tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr className="border-t border-ops-line" key={check[0]}>
                  {check.slice(0, 3).map((cell) => <td className="px-5 py-4" key={cell}>{cell}</td>)}
                  <td className="px-5 py-4"><StatusPill tone={check[3] === "正常" ? "green" : "amber"}>{check[3]}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </ConsoleShell>
  );
}

function MetricBox({ label, value, sub }) {
  return (
    <div className="border-b border-ops-line p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="text-sm font-bold text-ops-muted">{label}</div>
      <div className="mt-1 text-2xl font-black">{value}</div>
      <div className="mt-1 text-xs text-ops-muted">{sub}</div>
    </div>
  );
}
