"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { useLanguage } from "../components/LanguageProvider";
import { useSession } from "../components/SessionProvider";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { Card, PageHeader, Field, inputClass } from "../components/ui";
import { PUBLISHER_HEARTBEAT_STALE_MS } from "../../lib/live-status.mjs";
import { arePublisherBlockingChecksHealthy, buildPublisherStatusChecks } from "../../lib/distribution-ui.mjs";

const DEMO_CHAT_ID = "-1003710405969";

export default function TelegramUserAuthorizationPage() {
  const { t } = useLanguage();
  const { user } = useSession();
  const readonly = user?.role === "manual_publisher";
  const [publisher, setPublisher] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/telegram/user-authorization", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || t("publisher.loadError"));
      setPublisher(data.publisher || null);
      setAccounts(data.accounts || []);
      setError("");
    } catch (nextError) {
      setError(nextError.message || t("publisher.statusError"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  useEffect(() => { refresh(); }, [refresh]);
  useLiveAutoRefresh(() => refresh({ silent: true }), { enabled: !loading });

  const operationalStatus = publisher?.operationalStatus || "offline";
  const ready = publisher?.operationalReady === true;
  const statusLabel = loading ? t("common.refreshing")
    : operationalStatus === "publishing"
    ? t("publisher.publishing")
    : operationalStatus === "stalled"
      ? t("publisher.stalled")
      : operationalStatus === "degraded"
        ? t("publisher.degraded")
        : ready
          ? t("publisher.online")
          : t("publisher.offline");
  const approvedTargets = publisher?.approvedTargetIds || [];
  const lastSeenAt = publisher?.lastSeenAt || publisher?.lastVerifiedAt || null;
  const checks = buildPublisherStatusChecks(publisher || {});
  const allChecksHealthy = !loading && arePublisherBlockingChecksHealthy(checks);
  return (
    <ConsoleShell>
      <PageHeader
        title={t("publisher.title")}
        desc={t("publisher.desc")}
        action={<Link className="grid min-h-11 place-items-center rounded-lg bg-ops-accent px-5 text-sm font-black text-white" href="/composer">{t("publisher.openComposer")}</Link>}
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <LiveStatusStamp generatedAt={lastSeenAt} error={error} refreshing={loading} staleAfterMs={PUBLISHER_HEARTBEAT_STALE_MS} />
        <button className="min-h-11 rounded-lg border border-ops-accent bg-white px-5 text-sm font-black text-ops-accent disabled:opacity-50" disabled={loading} onClick={() => refresh()} type="button">
          {loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      </div>

      <section className="mb-5 grid overflow-hidden rounded-lg border border-ops-line bg-white shadow-ops sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t("publisher.accounts")} value={loading ? "—" : t("publisher.count", { count: accounts.length })} ok={!loading && accounts.length > 0} />
        <Metric label={t("publisher.bridge")} value={statusLabel} ok={ready || operationalStatus === "publishing"} />
        <Metric label={t("publisher.targets")} value={loading ? "—" : t("publisher.count", { count: approvedTargets.length })} ok={!loading && approvedTargets.length > 0} />
        <Metric label={t("publisher.fallback")} value={t("publisher.noAnonymous")} ok />
      </section>

      {readonly ? <div className="mb-5 rounded-lg border border-ops-line bg-ops-soft px-4 py-3 text-sm font-bold text-ops-accent">{t("publisher.readonly")}</div> : null}

      {(error || publisher?.operationalError) ? (
        <div className="mb-5 rounded-lg border border-[#e4c88b] bg-[#fff7e6] px-4 py-3 text-sm font-bold text-[#80591c]" role="alert">
          {error || publisher.operationalError}
        </div>
      ) : null}

      {!loading && !allChecksHealthy ? (
        <div className="mb-5 rounded-lg border border-[#e4c88b] bg-[#fff7e6] px-4 py-3 text-sm font-bold text-[#80591c]" role="status">
          {t("publisher.healthPending")}
        </div>
      ) : null}

      {!loading && (
        <Card className="mb-5 p-6 border-ops-line bg-white">
          <h2 className="text-xl font-black mb-4">{t("publisher.accounts")}</h2>
          {accounts.length === 0 ? (
            <p className="text-ops-muted text-sm">{t("publisher.none")}</p>
          ) : (
            <div className="grid gap-3">
              {accounts.map(account => (
                <div key={account.userId} className="flex items-center justify-between p-4 bg-[#fdfefe] border border-ops-line rounded-lg">
                  <div>
                    <div className="font-bold">{account.firstName} {account.lastName}</div>
                    <div className="text-sm text-ops-muted">@{account.username || account.userId}</div>
                  </div>
                  {!readonly ? <button
                    onClick={async () => {
                      if (confirm("确定要移除该账号的授权吗？")) {
                        await fetch(`/api/telegram-auth/session?userId=${account.userId}`, { method: "DELETE" });
                        refresh();
                      }
                    }}
                    className="text-sm font-bold text-[#a04a3d] hover:underline"
                  >
                    {t("common.delete")}
                  </button> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {!readonly ? <TelegramLogin onLoginSuccess={() => refresh()} /> : null}

      {!readonly ? <><Card className="mt-5 p-6">
        <h2 className="text-xl font-black">发布边界</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Scope title="当前验收群" value="Demo Academy Forum" />
          <Scope title="Telegram Chat ID" value={DEMO_CHAT_ID} mono />
          <Scope title="显示效果" value="群名称和群头像，不显示 Bot 或个人账号" />
        </div>
        <p className="mt-4 text-sm leading-6 text-ops-muted">只有白名单内、且 @Serenity_Crypto 已设为匿名管理员 / Send As 群身份的 Forum 群可以发布。新增正式群必须先在“群与 Topic”完成权限核验，再明确批准加入白名单。</p>
      </Card>

      <Card className="mt-5 p-6">
        <h2 className="text-xl font-black">后台能力组件仍然保留</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Scope title="AdminBot" value="群发现、Topic 初始化、权限复核" />
          <Scope title="SpeakerBot" value="Trader 私聊接收、订单核验" />
          <Scope title="ForwardBot" value="来源群 / Channel 新消息监听" />
        </div>
        <p className="mt-4 text-sm leading-6 text-ops-muted">三个 Bot 是后台能力组件，不是可见发言人。它们保留原功能，但所有获准的出站内容都统一进入 @Serenity_Crypto 发布队列。</p>
      </Card></> : null}
    </ConsoleShell>
  );
}

function Metric({ label, value, ok }) {
  return <div className="border-b border-ops-line p-5 last:border-0 sm:border-r xl:border-b-0"><div className="text-sm font-bold text-ops-muted">{label}</div><div className={`mt-1 text-xl font-black ${ok ? "text-ops-accent" : "text-[#8a5d1a]"}`}>{value}</div></div>;
}

function Scope({ title, value, mono = false }) {
  return <div className="rounded-lg bg-[#f7f9f8] p-4"><div className="text-xs font-bold text-ops-muted">{title}</div><div className={`mt-1 font-black ${mono ? "font-mono" : ""}`}>{value}</div></div>;
}

function TelegramLogin({ onLoginSuccess }) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [step, setStep] = useState(1);
  const [phoneCodeHash, setPhoneCodeHash] = useState("");
  const [sessionString, setSessionString] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function requestCode() {
    if (!phoneNumber) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/telegram-auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "获取验证码失败");
      setPhoneCodeHash(data.phoneCodeHash);
      setSessionString(data.session);
      setStep(2);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (!phoneCode) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/telegram-auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber, phoneCode, phoneCodeHash, session: sessionString })
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.needsPassword) {
          setStep(3);
          return;
        }
        throw new Error(data.error || "登录验证失败");
      }
      if (!data.ok) throw new Error(data.error || "登录验证失败");
      onLoginSuccess();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyPassword() {
    if (!password) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/telegram-auth/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, session: sessionString })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "密码验证失败");
      setStep(1);
      setPhoneNumber("");
      setPhoneCode("");
      setPassword("");
      onLoginSuccess();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5 p-6 border-ops-accent border-2 bg-[#fdfefe]">
      <h2 className="text-xl font-black text-ops-accent">添加 Telegram 账号</h2>
      <p className="mt-2 text-sm text-ops-muted">请输入需要授权发布的 Telegram 账号手机号（包含国际区号，如 +1234567890）。</p>
      
      {error && <div className="mt-3 text-sm font-bold text-[#a04a3d] bg-[#fef5f4] p-3 rounded">{error}</div>}

      <div className="mt-4 grid gap-4 max-w-sm">
        {step === 1 && (
          <>
            <Field label="手机号码">
              <input type="text" className={inputClass} placeholder="+1234567890" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} disabled={busy} />
            </Field>
            <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" onClick={requestCode} disabled={busy || !phoneNumber}>
              {busy ? "请求中..." : "获取验证码"}
            </button>
          </>
        )}
        
        {step === 2 && (
          <>
            <Field label="验证码">
              <input type="text" className={inputClass} placeholder="输入 Telegram 收到的 5 位验证码" value={phoneCode} onChange={(e) => setPhoneCode(e.target.value)} disabled={busy} />
            </Field>
            <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" onClick={verifyCode} disabled={busy || !phoneCode}>
              {busy ? "验证中..." : "确认登录"}
            </button>
            <button className="text-sm font-bold text-ops-muted underline mt-2 text-left" onClick={() => setStep(1)} disabled={busy}>
              修改手机号
            </button>
          </>
        )}

        {step === 3 && (
          <>
            <Field label="Enter Password">
              <input type="password" className={inputClass} placeholder="Enter Password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            </Field>
            <button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" onClick={verifyPassword} disabled={busy || !password}>
              {busy ? "验证中..." : "确认登录"}
            </button>
            <button className="text-sm font-bold text-ops-muted underline mt-2 text-left" onClick={() => setStep(1)} disabled={busy}>
              重新开始
            </button>
          </>
        )}
      </div>
    </Card>
  )
}
