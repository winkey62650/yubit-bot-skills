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

const pendingChecks = [
  { name: "生产后台", target: "/login", message: "等待首次检查", ok: null },
  { name: "内容分发调度", target: "production-worker", message: "等待首次检查", ok: null },
  { name: "自动发布任务", target: "automation-jobs", message: "等待首次检查", ok: null },
  { name: "新群初始化", target: "new-group-setup", message: "等待首次检查", ok: null },
  { name: "Lark 推送", target: "Lark Webhook", message: "等待首次检查", ok: null }
];

export default function SettingsPage() {
  const [settings, setSettings] = useState(defaultSettings);
  const [saveStatus, setSaveStatus] = useState("正在读取云端设置...");
  const [saving, setSaving] = useState(false);
  const [monitorStatus, setMonitorStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState("尚未执行真实推送测试");
  const [settingsLoaded, setSettingsLoaded] = useState(false);

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
      .catch((error) => setSaveStatus(`读取失败：${error.message}`))
      .finally(() => setSettingsLoaded(true));
    refreshMonitorStatus().catch((error) => setTestStatus(`读取运行状态失败：${error.message}`));
  }, []);

  async function refreshMonitorStatus() {
    const response = await fetch("/api/lark-monitor", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "读取 Lark 运行状态失败");
    setMonitorStatus(data.status);
    if (data.status.lastError) {
      setTestStatus(`最近推送失败：${data.status.lastError}`);
    } else if (data.status.lastSuccessfulNotificationAt) {
      setTestStatus(`最近成功推送 · ${new Date(data.status.lastSuccessfulNotificationAt).toLocaleString()}`);
    }
    return data.status;
  }

  function update(field, value) {
    if (!settingsLoaded) return;
    setSettings((current) => ({ ...current, [field]: value }));
    setSaveStatus("有未保存的修改");
  }

  async function save() {
    if (!settingsLoaded || saving) return;
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

  async function testLark() {
    if (!settingsLoaded || testing || saving || !settings.webhook.trim()) return;
    setTesting(true);
    setTestStatus("正在保存当前配置并发送真实测试消息...");
    try {
      const saved = await saveWorkspaceState("settings", settings);
      setSettings(saved.state);
      setSaveStatus(`已保存到云端 · ${new Date(saved.updatedAt).toLocaleString()}`);
      const response = await fetch("/api/lark-monitor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test" })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Lark 测试推送失败");
      const status = await refreshMonitorStatus();
      setTestStatus(`测试消息已送达 · ${new Date(status.lastSuccessfulNotificationAt).toLocaleString()}`);
    } catch (error) {
      setTestStatus(`测试失败：${error.message}`);
    } finally {
      setTesting(false);
    }
  }

  const configured = Boolean(settings.webhook) && settings.status === "启用";
  const verified = monitorStatus?.verified === true;
  const checks = monitorStatus?.lastResult?.checks?.length ? monitorStatus.lastResult.checks : pendingChecks;
  const monitoringPaused = settingsLoaded && settings.status === "暂停";
  const currentStatus = !settingsLoaded
    ? "—"
    : monitoringPaused
      ? "已暂停"
      : verified
        ? "已验证"
        : configured
          ? "待验证"
          : "待配置";
  const currentStatusDetail = !settingsLoaded
    ? "正在核验配置"
    : monitoringPaused
      ? verified
        ? "监控未运行；最近一次真实消息已成功送达"
        : "监控任务不会运行"
      : verified
        ? "真实消息已成功送达"
        : configured
          ? "请发送测试消息"
          : "填入 Webhook 并启用";

  return (
    <ConsoleShell>
      <PageHeader title="系统设置" desc="配置程序健康检查、定时监控和 Lark 告警推送；保存后可在其他设备登录恢复。" />
      <section className="mb-5 grid gap-0 overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops md:grid-cols-4">
        <MetricBox label="检查频率" value={settingsLoaded ? settings.frequency : "—"} sub={settingsLoaded ? "可按业务低频调整" : "正在读取云端设置"} />
        <MetricBox label="监控程序" value="5" sub="后台 / 内容分发 / 自动任务 / 建群 / Lark" />
        <MetricBox label="告警渠道" value="Lark" sub="Webhook 推送" />
        <MetricBox label="当前状态" value={currentStatus} sub={currentStatusDetail} />
      </section>

      <Card className="p-6">
        <h2 className="text-xl font-black">Lark 监控配置</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <Field label="Lark Webhook"><input className={inputClass} type="password" autoComplete="off" disabled={!settingsLoaded || saving} value={settings.webhook} onChange={(event) => update("webhook", event.target.value)} placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/..." /></Field>
          <Field label="检查频率"><select className={inputClass} disabled={!settingsLoaded || saving} value={settings.frequency} onChange={(event) => update("frequency", event.target.value)}><option>每 5 分钟</option><option>每 15 分钟</option><option>每 30 分钟</option><option>每 1 小时</option></select></Field>
          <Field label="告警模式"><select className={inputClass} disabled={!settingsLoaded || saving} value={settings.alertMode} onChange={(event) => update("alertMode", event.target.value)}><option>异常才推送</option><option>每次检查都推送</option><option>每日汇总</option></select></Field>
          <Field label="连续失败阈值"><select className={inputClass} disabled={!settingsLoaded || saving} value={settings.failureThreshold} onChange={(event) => update("failureThreshold", event.target.value)}><option>1 次失败立即告警</option><option>2 次连续失败告警</option><option>3 次连续失败告警</option></select></Field>
          <Field label="监控环境"><select className={inputClass} disabled={!settingsLoaded || saving} value={settings.environment} onChange={(event) => update("environment", event.target.value)}><option>本地控制台</option><option>生产环境</option><option>全部环境</option></select></Field>
          <Field label="状态"><select className={inputClass} disabled={!settingsLoaded || saving} value={settings.status} onChange={(event) => update("status", event.target.value)}><option>启用</option><option>暂停</option></select></Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button className="rounded-lg bg-ops-accent px-5 py-3 text-sm font-black text-white disabled:opacity-60" disabled={!settingsLoaded || saving} onClick={save} type="button">{saving ? "保存中..." : settingsLoaded ? "保存设置" : "正在读取设置…"}</button>
          <button className="rounded-lg border border-ops-accent bg-white px-5 py-3 text-sm font-black text-ops-accent disabled:opacity-50" disabled={!settingsLoaded || testing || saving || !settings.webhook.trim()} onClick={testLark} type="button">{testing ? "测试中..." : "发送测试消息"}</button>
          <span className="text-xs font-bold text-ops-accent">{saveStatus}</span>
        </div>
        <div className={`mt-3 rounded-lg px-4 py-3 text-sm font-bold ${verified ? "bg-[#e6f7ef] text-ops-accent" : "bg-[#fff4df] text-[#9a671d]"}`}>{testStatus}</div>
      </Card>

      <Card className="mt-5 overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">程序健康检查</h2>
          <p className="mt-1 text-sm text-ops-muted">{monitoringPaused ? "仅暂停 Lark 健康监控；以下为最近一次检查结果，不影响内容分发调度与自动发布。" : "生产 Worker 每分钟核对是否到达检查时间；到点后按上方频率执行，异常时根据阈值推送。"}</p>
          {monitorStatus?.lastRunAt ? <p className="mt-2 text-xs font-bold text-ops-accent">最近检查：{new Date(monitorStatus.lastRunAt).toLocaleString()} · {monitorStatus.lastResult?.summary}</p> : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">项目</th><th className="px-5 py-3">检查对象</th><th className="px-5 py-3">结果</th><th className="px-5 py-3">状态</th></tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr className="border-t border-ops-line" key={check.name}>
                  <td className="px-5 py-4 font-bold">{check.name}</td>
                  <td className="px-5 py-4">{check.target || "—"}</td>
                  <td className="px-5 py-4">{check.message || "—"}{Number.isFinite(check.latencyMs) ? ` · ${check.latencyMs}ms` : ""}</td>
                  <td className="px-5 py-4"><StatusPill tone={check.ok === true ? "green" : "amber"}>{monitoringPaused ? check.ok === true ? "历史正常" : check.ok === false ? "历史异常" : "待检查" : check.ok === true ? "正常" : check.ok === false ? "异常" : "待检查"}</StatusPill></td>
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
