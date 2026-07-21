"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";

const endpoint = "/api/telegram/user-authorization";

export default function TelegramUserAuthorizationPage() {
  const [publisher, setPublisher] = useState(null);
  const [flowId, setFlowId] = useState("");
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("正在读取授权状态…");

  useEffect(() => { refreshStatus(); }, []);

  async function refreshStatus() {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "授权状态读取失败");
      setPublisher(data.publisher);
      setNotice(data.publisher?.ready ? "@Serenity_Crypto 已授权，当前只允许发布到私有 Demo Channel。" : "请完成 Telegram 用户账号授权。");
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function begin(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("正在请求 Telegram 发送验证码…");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "begin", apiId, apiHash, phoneNumber })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "授权启动失败");
      setFlowId(data.authorization.flowId);
      setApiId("");
      setApiHash("");
      setPhoneNumber("");
      setNotice(data.authorization.codeViaApp ? "验证码已发到本机 Telegram App。" : "请输入 Telegram 发送的验证码。");
    } catch (error) {
      setApiHash("");
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function complete(event) {
    event.preventDefault();
    if (busy || !flowId) return;
    setBusy(true);
    setNotice("正在完成授权并加密保存会话…");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete", flowId, phoneCode, password })
      });
      const data = await response.json();
      setPhoneCode("");
      setPassword("");
      if (!response.ok || !data.ok) throw new Error(data.error || "授权失败");
      setFlowId("");
      setPublisher(data.publisher);
      setNotice("授权成功。会话与 API Hash 已在服务器加密保存，页面不保留验证码或密码。");
    } catch (error) {
      setPhoneCode("");
      setPassword("");
      setFlowId("");
      setNotice(`${error.message}请重新开始授权。`);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy || !flowId) return;
    setBusy(true);
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", flowId })
      });
    } finally {
      setFlowId("");
      setPhoneCode("");
      setPassword("");
      setBusy(false);
      setNotice("已取消本次授权。");
    }
  }

  const ready = publisher?.ready === true;
  return (
    <ConsoleShell>
      <PageHeader
        title="Telegram 发布账号授权"
        desc="将 @Serenity_Crypto 作为统一出站发布账号。授权成功后，Channel 使用 Channel 名称和头像展示，Forum 群使用 @Serenity_Crypto 身份发布。"
        action={<Link className="grid min-h-11 place-items-center rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent" href="/group-config">返回群配置</Link>}
      />

      <section className="mb-5 grid overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="账号" value={publisher?.username || "@Serenity_Crypto"} ok={publisher?.authorized} />
        <Metric label="会话授权" value={publisher?.authorized ? "已授权" : "待授权"} ok={publisher?.authorized} />
        <Metric label="加密存储" value={publisher?.encryptionReady && publisher?.configured ? "已就绪" : "未就绪"} ok={publisher?.encryptionReady && publisher?.configured} />
        <Metric label="出站发布" value={ready ? "可用" : "停用"} ok={ready} />
      </section>

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-xl font-black">安全授权向导</h2><p className="mt-1 text-sm text-ops-muted">API Hash、验证码和 2FA 密码不会写入浏览器存储或运行日志。</p></div>
          <StatusPill tone={ready ? "green" : "amber"}>{ready ? "已可发布" : flowId ? "等待验证码" : "待授权"}</StatusPill>
        </div>

        {!flowId ? (
          <form className="mt-6 grid gap-4 md:grid-cols-3" onSubmit={begin}>
            <Field label="Telegram API ID">
              <input className={inputClass} inputMode="numeric" autoComplete="off" value={apiId} onChange={(event) => setApiId(event.target.value)} required />
            </Field>
            <Field label="Telegram API Hash">
              <input className={inputClass} type="password" autoComplete="new-password" value={apiHash} onChange={(event) => setApiHash(event.target.value)} required />
            </Field>
            <Field label="@Serenity_Crypto 国际格式手机号">
              <input className={inputClass} type="tel" autoComplete="off" placeholder="+8613800000000" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} required />
            </Field>
            <div className="md:col-span-3 flex flex-wrap items-center gap-3">
              <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" disabled={busy} type="submit">{busy ? "请求中…" : "发送 Telegram 验证码"}</button>
              <a className="text-sm font-bold text-ops-accent underline" href="https://my.telegram.org/apps" rel="noreferrer" target="_blank">在 my.telegram.org/apps 获取 API ID / Hash</a>
            </div>
          </form>
        ) : (
          <form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={complete}>
            <Field label="Telegram 验证码">
              <input className={inputClass} type="password" inputMode="numeric" autoComplete="one-time-code" value={phoneCode} onChange={(event) => setPhoneCode(event.target.value)} required />
            </Field>
            <Field label="Telegram 2FA 密码（未开启可留空）">
              <input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </Field>
            <div className="md:col-span-2 flex flex-wrap gap-3">
              <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" disabled={busy} type="submit">{busy ? "验证中…" : "完成授权"}</button>
              <button className="min-h-11 rounded-lg border border-ops-line px-5 text-sm font-black disabled:opacity-50" disabled={busy} onClick={cancel} type="button">取消</button>
            </div>
          </form>
        )}

        <p aria-live="polite" className={`mt-5 rounded-lg px-4 py-3 text-sm font-bold ${ready ? "bg-[#e6f7ef] text-ops-accent" : "bg-[#fff4df] text-[#8a5d1a]"}`}>{notice}</p>
      </Card>

      <Card className="mt-5 p-6">
        <h2 className="text-xl font-black">本轮验收边界</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Scope title="唯一目标" value="私有 Demo Channel" />
          <Scope title="Telegram Chat ID" value="-1003862539988" mono />
          <Scope title="验收项" value="文字、图片、一次性定时发布" />
        </div>
        <p className="mt-4 text-sm leading-6 text-ops-muted">Fight Club、CryptoGuy 和其他群 / Channel 全部不在本轮许可范围内。授权中断或服务重启时，需重新开始授权；系统不会静默回退到 Bot 发帖。</p>
      </Card>
    </ConsoleShell>
  );
}

function Metric({ label, value, ok }) {
  return <div className="border-b border-ops-line p-5 last:border-0 sm:border-r xl:border-b-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className={`mt-1 text-xl font-black ${ok ? "text-ops-accent" : "text-[#8a5d1a]"}`}>{value}</div></div>;
}

function Scope({ title, value, mono = false }) {
  return <div className="rounded-lg bg-[#f7f9f8] p-4"><div className="text-xs font-bold text-ops-muted">{title}</div><div className={`mt-1 font-black ${mono ? "font-mono" : ""}`}>{value}</div></div>;
}
