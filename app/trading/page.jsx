"use client";

import { useEffect, useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, Metric, PageHeader, StatusPill, inputClass } from "../components/ui";
import { normalizeDistributionGroupTopics } from "../../lib/distribution-ui.mjs";

const tabs = [
  ["logs", "交易日志"],
  ["traders", "Trader 管理"],
  ["destinations", "发布目标"],
  ["health", "系统状态"],
];

const emptyData = {
  metrics: {}, traders: [], accounts: [], destinations: [], signals: [], deliveries: [], logs: [], health: {},
};
const emptyTrader = { id: "", displayName: "", telegramUserId: "", telegramUsername: "", status: "enabled" };
const emptyAccount = { id: "", label: "", apiKey: "", apiSecret: "", traderIds: [], status: "pending" };
const emptyDestination = { id: "", scopeType: "workspace", scopeId: "", targetKey: "", chatId: "", threadId: "", chatTitle: "", topicTitle: "", enabled: true };

export default function TradingPage() {
  const [view, setView] = useState("logs");
  const [data, setData] = useState(emptyData);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [traderForm, setTraderForm] = useState(emptyTrader);
  const [accountForm, setAccountForm] = useState(emptyAccount);
  const [destinationForm, setDestinationForm] = useState(emptyDestination);
  const [verifySymbol, setVerifySymbol] = useState("BTCUSDT");
  const [selectedSignal, setSelectedSignal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll(showLoading = true) {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const [tradingResponse, groupsResponse] = await Promise.all([
        fetch("/api/trading", { cache: "no-store" }),
        fetch("/api/group-config", { cache: "no-store" }),
      ]);
      const [overview, groupConfig] = await Promise.all([tradingResponse.json(), groupsResponse.json()]);
      if (!tradingResponse.ok || !overview.ok) throw new Error(overview.error || "交易中心读取失败");
      if (!groupsResponse.ok || groupConfig.ok === false) throw new Error(groupConfig.error || "群与 Topic 读取失败");
      setData({ ...emptyData, ...overview });
      setGroups(Array.isArray(groupConfig.groups) ? groupConfig.groups : []);
    } catch (loadError) {
      setError(loadError.message || "交易中心加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function post(body, successMessage) {
    const action = body.action || "save";
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/trading", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "操作失败");
      setNotice(result.message || successMessage);
      await loadAll(false);
      return result;
    } catch (postError) {
      setError(yubitAccountError(postError.message || "操作失败"));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function openSignal(signal) {
    setSelectedSignal(signal);
    setDetail(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/trading/signals/${signal.id}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "订单详情读取失败");
      setDetail(result);
    } catch (detailError) {
      setError(detailError.message || "订单详情读取失败");
    } finally {
      setDetailLoading(false);
    }
  }

  async function refreshSignal(signalId) {
    setBusy(`refresh-${signalId}`);
    setError("");
    try {
      const response = await fetch(`/api/trading/signals/${signalId}/refresh`, { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "订单刷新失败");
      setNotice(result.message || "YUBIT 订单状态已刷新");
      await loadAll(false);
      if (selectedSignal?.id === signalId) await openSignal({ id: signalId });
    } catch (refreshError) {
      setError(refreshError.message || "订单刷新失败");
    } finally {
      setBusy("");
    }
  }

  async function retryDelivery(deliveryId) {
    setBusy(`retry-${deliveryId}`);
    setError("");
    try {
      const response = await fetch(`/api/trading/deliveries/${deliveryId}/retry`, { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "投递重试失败");
      setNotice(result.message || "失败目标已重试");
      await loadAll(false);
      if (selectedSignal?.id) await openSignal(selectedSignal);
    } catch (retryError) {
      setError(retryError.message || "投递重试失败");
    } finally {
      setBusy("");
    }
  }

  function changeView(next) {
    setView(next);
    setNotice("");
    setError("");
  }

  return (
    <ConsoleShell>
      <PageHeader
        title="交易中心"
        desc="Trader 私聊 SpeakerBot 提交 YUBIT 订单号；系统用只读 API 核验订单、同步交易信号、持续追踪，并且只为真实盈利订单发布 PNL 卡片。"
        action={<button className="min-h-11 rounded-lg border border-ops-accent px-5 text-sm font-black text-ops-accent disabled:opacity-50" disabled={loading || Boolean(busy)} onClick={() => loadAll()} type="button">刷新数据</button>}
      />

      <div className="mb-5 rounded-lg border border-[#d9bd73] bg-[#fff9e8] px-4 py-3" role="status">
        <p className="text-sm font-black text-[#5f4513]">DEMO 验收锁已开启</p>
        <p className="mt-1 text-xs leading-5 text-[#7b642f]">交易信号、盈利 PNL 和测试消息目前只会发送到 DEMO Academy。只有在你明确批准后，系统才会开放其他群。</p>
      </div>

      {notice ? <div className="mb-5 rounded-lg border border-[#b8dfcd] bg-[#f2faf6] px-4 py-3 text-sm font-bold text-[#285845]" role="status">{notice}</div> : null}
      {error ? <div className="mb-5 rounded-lg border border-[#efc2bd] bg-[#fff6f5] px-4 py-3 text-sm font-bold text-[#9d3128]" role="alert">操作失败：{error}</div> : null}

      <div className="mb-5 flex gap-2 overflow-x-auto border-b border-ops-line" role="tablist" aria-label="交易中心功能">
        {tabs.map(([key, label]) => <button aria-selected={view === key} className={`min-h-12 whitespace-nowrap border-b-2 px-4 text-sm font-black ${view === key ? "border-ops-accent text-ops-accent" : "border-transparent text-ops-muted"}`} key={key} onClick={() => changeView(key)} role="tab" type="button">{label}</button>)}
      </div>

      {loading ? <Card className="p-10 text-center font-bold text-ops-muted">正在读取交易中心…</Card> : null}
      {!loading && view === "logs" ? <TradingLogs data={data} busy={busy} detail={detail} detailLoading={detailLoading} selectedSignal={selectedSignal} onCopy={copyText} onOpen={openSignal} onRefresh={refreshSignal} onRetry={retryDelivery} /> : null}
      {!loading && view === "traders" ? <TraderManagement data={data} busy={busy} traderForm={traderForm} setTraderForm={setTraderForm} accountForm={accountForm} setAccountForm={setAccountForm} verifySymbol={verifySymbol} setVerifySymbol={setVerifySymbol} onPost={post} onCopy={copyText} /> : null}
      {!loading && view === "destinations" ? <DestinationManagement data={data} groups={groups} busy={busy} form={destinationForm} setForm={setDestinationForm} onPost={post} /> : null}
      {!loading && view === "health" ? <SystemHealth data={data} busy={busy} onPost={post} /> : null}
    </ConsoleShell>
  );

  async function copyText(value, label = "内容") {
    try {
      await navigator.clipboard.writeText(String(value ?? ""));
      setNotice(`${label}已复制`);
    } catch {
      setError("复制失败，请手动选择并复制");
    }
  }
}

function TradingLogs({ data, busy, detail, detailLoading, selectedSignal, onCopy, onOpen, onRefresh, onRetry }) {
  const [traderFilter, setTraderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const tradersById = useMemo(() => new Map(data.traders.map((trader) => [trader.id, trader])), [data.traders]);
  const signals = data.signals.filter((signal) => {
    const keyword = search.trim().toLowerCase();
    const matchesSearch = !keyword || [signal.symbol, signal.exchangeOrderId, tradersById.get(signal.traderId)?.displayName].some((value) => String(value || "").toLowerCase().includes(keyword));
    return matchesSearch && (!traderFilter || signal.traderId === traderFilter) && (!statusFilter || signal.status === statusFilter);
  });

  return <div className="grid gap-5">
    <Card className="grid md:grid-cols-2 xl:grid-cols-4">
      <Metric icon="单" label="全部订单" value={data.metrics.totalSignals || 0} sub={`${data.metrics.trackingSignals || 0} 笔持续追踪`} />
      <Metric icon="盈" label="盈利订单" value={data.metrics.profitableSignals || 0} sub="仅盈利订单生成 PNL 卡片" />
      <Metric icon="审" label="需要复核" value={data.metrics.needsReview || 0} sub="不会自动发布可疑订单" />
      <Metric icon="重" label="失败投递" value={data.metrics.failedDeliveries || 0} sub="可按目标单独重试" />
    </Card>

    <Card className="p-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="搜索订单"><input className={inputClass} onChange={(event) => setSearch(event.target.value)} placeholder="币种、订单号或 Trader" value={search} /></Field>
        <Field label="Trader"><select className={inputClass} onChange={(event) => setTraderFilter(event.target.value)} value={traderFilter}><option value="">全部 Trader</option>{data.traders.map((trader) => <option key={trader.id} value={trader.id}>{trader.displayName}</option>)}</select></Field>
        <Field label="订单状态"><select className={inputClass} onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}><option value="">全部状态</option>{["tracking", "closed_profit", "closed_loss", "needs_review", "rejected"].map((status) => <option key={status} value={status}>{signalStatus(status)}</option>)}</select></Field>
      </div>
    </Card>

    <Card className="overflow-hidden">
      <div className="border-b border-ops-line px-5 py-4"><h2 className="text-lg font-black">交易日志</h2><p className="mt-1 text-sm text-ops-muted">订单号来自 Trader，订单事实来自 YUBIT 只读 API，人工说明与事实分开记录。</p></div>
      {!signals.length ? <Empty text="暂无交易记录。Trader 向 SpeakerBot 发送订单号后会出现在这里。" /> : <div className="overflow-x-auto"><table className="min-w-[980px] w-full text-left text-sm"><thead className="bg-[#f7f9f8] text-xs text-ops-muted"><tr><Th>订单</Th><Th>Trader</Th><Th>方向 / 杠杆</Th><Th>状态</Th><Th>已实现盈亏</Th><Th>更新时间</Th><Th>操作</Th></tr></thead><tbody>{signals.map((signal) => <tr className="border-t border-ops-line" key={signal.id}><Td><strong>{signal.symbol || "—"}</strong><button className="mt-1 block max-w-[230px] break-all text-left font-mono text-xs text-ops-accent" onClick={() => onCopy(signal.exchangeOrderId, "订单号")} type="button">{signal.exchangeOrderId || signal.id}</button></Td><Td>{tradersById.get(signal.traderId)?.displayName || "未知 Trader"}</Td><Td>{directionLabel(signal.side)}{signal.leverage ? ` · ${signal.leverage}x` : ""}</Td><Td><StatusPill tone={signalTone(signal.status)}>{signalStatus(signal.status)}</StatusPill></Td><Td className={Number(signal.realizedPnl) > 0 ? "font-black text-ops-accent" : ""}>{money(signal.realizedPnl)}</Td><Td>{formatDate(signal.updatedAt || signal.openedAt)}</Td><Td><div className="flex gap-2"><SmallButton onClick={() => onOpen(signal)}>详情</SmallButton><SmallButton disabled={busy === `refresh-${signal.id}`} onClick={() => onRefresh(signal.id)}>{busy === `refresh-${signal.id}` ? "刷新中…" : "立即刷新"}</SmallButton></div></Td></tr>)}</tbody></table></div>}
    </Card>

    {selectedSignal ? <SignalDetail signal={selectedSignal} detail={detail} loading={detailLoading} busy={busy} onCopy={onCopy} onRetry={onRetry} /> : null}
  </div>;
}

function SignalDetail({ signal, detail, loading, busy, onCopy, onRetry }) {
  if (loading) return <Card className="p-7 text-center font-bold text-ops-muted">正在读取订单证据链…</Card>;
  if (!detail) return null;
  const facts = detail.signal || signal;
  return <Card className="p-5 md:p-6">
    <div className="flex flex-col gap-2 border-b border-ops-line pb-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black uppercase tracking-wider text-ops-accent">只读核验详情</p><h2 className="mt-1 text-xl font-black">{facts.symbol} · {directionLabel(facts.side)}</h2></div><button className="break-all text-left font-mono text-xs text-ops-accent" onClick={() => onCopy(facts.exchangeOrderId, "订单号")} type="button">{facts.exchangeOrderId}</button></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Fact label="成交均价" value={facts.avgEntryPrice ?? "—"} /><Fact label="成交数量" value={facts.filledQty ?? "—"} /><Fact label="已实现盈亏" value={money(facts.realizedPnl)} /><Fact label="ROI" value={percent(facts.roi)} /></div>
    {detail.annotations?.length ? <div className="mt-5 rounded-lg border border-ops-line bg-[#fbfcfb] p-4"><h3 className="font-black">Trader 说明</h3>{detail.annotations.map((item) => <p className="mt-2 whitespace-pre-wrap text-sm leading-6" key={item.id}>{item.text || item.content || item.rationale}</p>)}</div> : null}
    <div className="mt-6 grid gap-5 xl:grid-cols-2">
      <div><h3 className="font-black">订单时间线</h3>{!detail.events?.length ? <p className="mt-3 text-sm text-ops-muted">暂无时间线事件。</p> : <div className="mt-3 grid gap-3">{detail.events.map((event) => <div className="border-l-2 border-[#b8dfcd] pl-3 text-sm" key={event.id}><strong>{eventLabel(event.eventType || event.type)}</strong><p className="mt-1 text-xs text-ops-muted">{formatDate(event.createdAt || event.occurredAt)}</p></div>)}</div>}</div>
      <div><h3 className="font-black">发布结果</h3>{!detail.deliveries?.length ? <p className="mt-3 text-sm text-ops-muted">暂无投递记录。</p> : <div className="mt-3 grid gap-3">{detail.deliveries.map((delivery) => <div className="rounded-lg border border-ops-line p-3" key={delivery.id}><div className="flex items-start justify-between gap-3"><div><strong className="text-sm">{delivery.destination?.chatTitle || delivery.destination?.chatId || "目标群"} / {delivery.destination?.topicTitle || delivery.destination?.threadId || "群聊"}</strong><p className="mt-1 text-xs text-ops-muted">{publicationLabel(delivery.publicationType)} · 尝试 {delivery.attempts || 0} 次</p></div><StatusPill tone={delivery.status === "failed" ? "amber" : "green"}>{deliveryStatus(delivery.status)}</StatusPill></div>{delivery.errorCode ? <p className="mt-2 break-all text-xs text-[#9d3128]">{delivery.errorCode}</p> : null}{delivery.status === "failed" ? <SmallButton className="mt-3" disabled={busy === `retry-${delivery.id}`} onClick={() => onRetry(delivery.id)}>{busy === `retry-${delivery.id}` ? "重试中…" : "单独重试"}</SmallButton> : null}</div>)}</div>}</div>
    </div>
  </Card>;
}

function TraderManagement({ data, busy, traderForm, setTraderForm, accountForm, setAccountForm, verifySymbol, setVerifySymbol, onPost, onCopy }) {
  async function saveTraderForm(event) {
    event.preventDefault();
    const previous = data.traders.find((item) => item.id === traderForm.id);
    if (previous?.status === "enabled" && traderForm.status === "disabled" && !window.confirm("停用后，这名 Trader 不能再提交新订单。确认停用？")) return;
    const result = await onPost({ action: "save-trader", trader: { ...traderForm, id: traderForm.id || undefined } }, "Trader 已保存");
    if (result) setTraderForm(emptyTrader);
  }

  async function saveAccountForm(event) {
    event.preventDefault();
    const previous = data.accounts.find((item) => item.id === accountForm.id);
    if (previous && previous.status !== "disabled" && accountForm.status === "disabled" && !window.confirm("停用后，该账户将停止订单核验和追踪。确认停用？")) return;
    const result = await onPost({ action: "save-account", account: { ...accountForm, id: accountForm.id || undefined } }, "YUBIT 查询账户已加密保存");
    if (result) setAccountForm(emptyAccount);
  }

  function editAccount(account) {
    setAccountForm({ id: account.id, label: account.label, apiKey: "", apiSecret: "", traderIds: account.traderIds || [], status: account.status });
  }

  return <div className="grid items-start gap-5 xl:grid-cols-2">
    <div className="grid gap-5">
      <Card className="p-5 md:p-6"><SectionHead title={traderForm.id ? "编辑 Trader" : "新增 Trader"} desc="仅允许登记的 Telegram 数字 ID 向 SpeakerBot 提交订单。" /><form className="mt-5 grid gap-4" onSubmit={saveTraderForm}><Field label="Trader 名称"><input className={inputClass} onChange={(event) => setTraderForm({ ...traderForm, displayName: event.target.value })} required value={traderForm.displayName} /></Field><Field label="Telegram 数字 ID"><input className={inputClass} inputMode="numeric" onChange={(event) => setTraderForm({ ...traderForm, telegramUserId: event.target.value })} placeholder="例如 123456789" required value={traderForm.telegramUserId} /></Field><Field label="Telegram 用户名（可选）"><input className={inputClass} onChange={(event) => setTraderForm({ ...traderForm, telegramUsername: event.target.value })} placeholder="不需要填写 @" value={traderForm.telegramUsername || ""} /></Field><Field label="状态"><select className={inputClass} onChange={(event) => setTraderForm({ ...traderForm, status: event.target.value })} value={traderForm.status}><option value="enabled">启用</option><option value="disabled">停用</option></select></Field><FormActions busy={busy === "save-trader"} editing={Boolean(traderForm.id)} onCancel={() => setTraderForm(emptyTrader)} /></form></Card>
      <Card className="p-5 md:p-6"><SectionHead title="Trader 列表" desc={`${data.metrics.orderReadyTraders || 0} 名订单核验已就绪`} />{!data.traders.length ? <Empty text="暂无 Trader。请先登记 Trader 的 Telegram 数字 ID。" /> : <div className="mt-4 grid gap-3">{data.traders.map((trader) => <TraderReadinessCard key={trader.id} onCopy={onCopy} onEdit={() => setTraderForm({ ...trader })} trader={trader} />)}</div>}</Card>
    </div>

    <div className="grid gap-5">
      <Card className="p-5 md:p-6"><SectionHead title={accountForm.id ? "编辑 YUBIT 查询账户" : "新增 YUBIT 查询账户"} desc="一个账户可关联多个 Trader；Trader 提交订单号时系统会从关联账户中核验。" /><div className="mt-4 rounded-lg border border-[#e7c883] bg-[#fff9e9] p-4 text-sm leading-6 text-[#6f551d]"><strong>安全要求：</strong>创建 API 时必须关闭交易、转账和提现权限，仅保留查询权限。后台验证只确认查询接口可用，管理员仍需在 YUBIT 确认权限范围。凭证只在服务端加密保存，页面不会回显 API Secret。</div><form className="mt-5 grid gap-4" onSubmit={saveAccountForm}><Field label="账户名称"><input className={inputClass} onChange={(event) => setAccountForm({ ...accountForm, label: event.target.value })} placeholder="例如 Trader A 主账户" required value={accountForm.label} /></Field><Field label="API Key"><input autoComplete="off" className={inputClass} onChange={(event) => setAccountForm({ ...accountForm, apiKey: event.target.value })} placeholder={accountForm.id ? "留空表示不更换" : "只读 API Key"} required={!accountForm.id} type="password" value={accountForm.apiKey} /></Field><Field label="API Secret"><input autoComplete="new-password" className={inputClass} onChange={(event) => setAccountForm({ ...accountForm, apiSecret: event.target.value })} placeholder={accountForm.id ? "留空表示不更换" : "只读 API Secret"} required={!accountForm.id} type="password" value={accountForm.apiSecret} /></Field><fieldset className="grid gap-2"><legend className="text-sm font-bold text-ops-muted">关联 Trader</legend>{!data.traders.length ? <p className="text-sm text-ops-muted">请先新增 Trader。</p> : data.traders.map((trader) => <label className="flex items-center gap-2 rounded-lg border border-ops-line p-3 text-sm font-bold" key={trader.id}><input checked={accountForm.traderIds.includes(trader.id)} onChange={() => setAccountForm({ ...accountForm, traderIds: toggleValue(accountForm.traderIds, trader.id) })} type="checkbox" />{trader.displayName}</label>)}</fieldset>{accountForm.id ? <label className="flex items-center gap-3 rounded-lg border border-ops-line p-3 text-sm font-bold"><input checked={accountForm.status !== "disabled"} onChange={(event) => setAccountForm({ ...accountForm, status: event.target.checked ? "pending" : "disabled" })} type="checkbox" />启用此查询账户；重新启用后需再次验证</label> : null}<FormActions busy={busy === "save-account"} editing={Boolean(accountForm.id)} onCancel={() => setAccountForm(emptyAccount)} /></form></Card>
      <Card className="p-5 md:p-6"><SectionHead title="YUBIT 查询账户" desc={`${data.metrics.verifiedAccounts || 0} 个查询验证通过`} />{!data.accounts.length ? <Empty text="暂无查询账户。账户保存后请立即验证查询权限。" /> : <div className="mt-4 grid gap-3">{data.accounts.map((account) => <ExchangeAccountCard account={account} busy={busy} key={account.id} onCopy={onCopy} onEdit={() => editAccount(account)} onPost={onPost} setVerifySymbol={setVerifySymbol} verifySymbol={verifySymbol} />)}</div>}</Card>
    </div>
  </div>;
}

function TraderReadinessCard({ trader, onCopy, onEdit }) {
  const readiness = traderReadiness(trader);
  return <div className="rounded-lg border border-ops-line p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <strong>{trader.displayName}</strong>
        <p className="mt-1 text-xs text-ops-muted">{trader.telegramUsername ? `@${trader.telegramUsername.replace(/^@/, "")}` : "未填写用户名"}</p>
        <button className="mt-1 block break-all text-left font-mono text-xs text-ops-accent" onClick={() => onCopy(trader.telegramUserId, "Telegram 数字 ID")} type="button">TG ID · {trader.telegramUserId}</button>
      </div>
      <StatusPill tone={readiness.tone}>{readiness.label}</StatusPill>
    </div>
    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
      <p className={`rounded-md px-3 py-2 font-bold ${trader.canVerifyOrders ? "bg-[#f2faf6] text-[#285845]" : "bg-[#fff9e9] text-[#6f551d]"}`}>YUBIT · {trader.verifiedAccountCount || 0} 个已验证账户</p>
      <p className={`rounded-md px-3 py-2 font-bold ${trader.canPublish ? "bg-[#f2faf6] text-[#285845]" : "bg-[#fff9e9] text-[#6f551d]"}`}>{trader.canPublish ? `发布 · ${trader.enabledDestinationCount} 个目标` : "发布目标待配置"}</p>
    </div>
    <SmallButton className="mt-3" onClick={onEdit}>编辑</SmallButton>
  </div>;
}

function ExchangeAccountCard({ account, busy, onCopy, onEdit, onPost, setVerifySymbol, verifySymbol }) {
  const disabled = account.status === "disabled";
  const missingLink = !disabled && !account.traderIds?.length;
  const linkText = disabled
    ? "账户已停用，不参与订单核验"
    : account.traderIds?.length
      ? `关联 ${account.traderIds.length} 名 Trader`
      : "尚未关联 Trader，请编辑账户并勾选 Trader";
  return <div className="rounded-lg border border-ops-line p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <strong>{account.label}</strong>
        <button className="mt-1 block break-all text-left font-mono text-xs text-ops-accent" onClick={() => onCopy(account.apiKeyMasked, "脱敏 API Key")} type="button">{account.apiKeyMasked || "Key 已加密"}</button>
        <p className={`mt-1 text-xs ${missingLink ? "font-bold text-[#9d3128]" : "text-ops-muted"}`}>{linkText} · {account.lastVerifiedAt ? `上次验证 ${formatDate(account.lastVerifiedAt)}` : disabled ? "不需要验证" : "尚未验证"}</p>
      </div>
      <StatusPill tone={account.status === "verified" ? "green" : "amber"}>{accountStatus(account.status)}</StatusPill>
    </div>
    {account.status === "invalid" && account.lastErrorCode ? <p className="mt-2 break-all text-xs leading-5 text-[#9d3128]">{yubitAccountError(account.lastErrorCode)}</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">
      <SmallButton onClick={onEdit}>编辑</SmallButton>
      <input aria-label="验证币种" className={`${inputClass} min-h-9 w-28`} disabled={disabled} onChange={(event) => setVerifySymbol(event.target.value.toUpperCase())} value={verifySymbol} />
      <SmallButton disabled={disabled || busy === "verify-account"} onClick={() => onPost({ action: "verify-account", accountId: account.id, symbol: verifySymbol }, "YUBIT 查询权限验证成功")}>{disabled ? "先启用账户" : busy === "verify-account" ? "验证中…" : "验证查询权限"}</SmallButton>
    </div>
  </div>;
}

function DestinationManagement({ data, groups, busy, form, setForm, onPost }) {
  const options = groupTopicOptions(groups);
  const canSaveDestination = Boolean(
    form.chatId
    && (form.scopeType !== "trader" || form.scopeId)
  );

  async function save(event) {
    event.preventDefault();
    const previous = data.destinations.find((item) => item.id === form.id);
    if (previous?.enabled && !form.enabled && !window.confirm("停用后，新的交易信号和盈利 PNL 不再发送到该目标。确认停用？")) return;
    const result = await onPost({ action: "save-destination", destination: { ...form, id: form.id || undefined, threadId: Number(form.threadId) || null, scopeId: form.scopeType === "trader" ? form.scopeId : null } }, "发布目标已保存");
    if (result) setForm(emptyDestination);
  }

  function chooseTarget(key) {
    const selected = options.find((option) => option.key === key);
    setForm({ ...form, targetKey: key, ...(selected?.target || {}) });
  }

  function edit(destination) {
    setForm({ ...destination, targetKey: `${destination.chatId}:${destination.threadId || 0}`, threadId: destination.threadId || "" });
  }

  async function test(destination) {
    if (!window.confirm(`将向“${destination.chatTitle || destination.chatId} / ${destination.topicTitle || "群聊"}”发送一条真实 Telegram 测试消息，确认继续？`)) return;
    await onPost({ action: "test-destination", destinationId: destination.id }, "Telegram 测试消息发送成功");
  }

  return <div className="grid items-start gap-5 xl:grid-cols-[minmax(340px,.8fr)_minmax(0,1.2fr)]">
    <Card className="p-5 md:p-6"><SectionHead title={form.id ? "编辑发布目标" : "新增发布目标"} desc="工作区目标接收所有 Trader；Trader 专属目标只接收指定 Trader。" /><form className="mt-5 grid gap-4" onSubmit={save}><Field label="发布范围"><select className={inputClass} onChange={(event) => setForm({ ...form, scopeType: event.target.value, scopeId: "" })} value={form.scopeType}><option value="workspace">所有 Trader</option><option value="trader">指定 Trader</option></select></Field>{form.scopeType === "trader" ? <Field label="Trader"><select className={inputClass} onChange={(event) => setForm({ ...form, scopeId: event.target.value })} required value={form.scopeId}><option value="">请选择 Trader</option>{data.traders.map((trader) => <option key={trader.id} value={trader.id}>{trader.displayName}</option>)}</select></Field> : null}<Field label="目标群 / Topic"><select className={inputClass} onChange={(event) => chooseTarget(event.target.value)} required value={form.targetKey}><option value="">请选择已识别的群与 Topic</option>{options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></Field><details className="rounded-lg border border-ops-line p-4"><summary className="cursor-pointer text-sm font-black">手动填写群 ID / Topic ID</summary><div className="mt-4 grid gap-3"><Field label="群 ID"><input className={inputClass} onChange={(event) => setForm({ ...form, chatId: event.target.value })} required value={form.chatId} /></Field><Field label="Topic ID"><input className={inputClass} inputMode="numeric" onChange={(event) => setForm({ ...form, threadId: event.target.value })} value={form.threadId} /></Field><Field label="群名称"><input className={inputClass} onChange={(event) => setForm({ ...form, chatTitle: event.target.value })} value={form.chatTitle || ""} /></Field><Field label="Topic 名称"><input className={inputClass} onChange={(event) => setForm({ ...form, topicTitle: event.target.value })} value={form.topicTitle || ""} /></Field></div></details><label className="flex items-center gap-3 rounded-lg border border-ops-line p-3 text-sm font-bold"><input checked={Boolean(form.enabled)} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} type="checkbox" />保存后立即启用</label><FormActions busy={busy === "save-destination"} disabled={!canSaveDestination} editing={Boolean(form.id)} onCancel={() => setForm(emptyDestination)} /></form></Card>
    <Card className="p-5 md:p-6"><SectionHead title="发布目标" desc="每个目标独立投递，单个目标失败不会影响其他群。" />{!data.destinations.length ? <Empty text="暂无发布目标。请先选择目标群与 Topic。" /> : <div className="mt-4 grid gap-3">{data.destinations.map((destination) => <div className="rounded-lg border border-ops-line p-4" key={destination.id}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><strong>{destination.chatTitle || destination.chatId}</strong><StatusPill tone={destination.enabled ? "green" : "amber"}>{destination.enabled ? "已启用" : "已停用"}</StatusPill></div><p className="mt-1 text-sm">{destination.topicTitle || (destination.threadId ? `Topic ${destination.threadId}` : "群聊")}</p><p className="mt-1 break-all font-mono text-xs text-ops-muted">{destination.chatId}:{destination.threadId || 0}</p><p className="mt-2 text-xs text-ops-muted">{destination.scopeType === "trader" ? `仅 ${data.traders.find((trader) => trader.id === destination.scopeId)?.displayName || "指定 Trader"}` : "所有 Trader"} · {destination.lastVerifiedAt ? `已验证 ${formatDate(destination.lastVerifiedAt)}` : "尚未验证"}</p>{destination.lastErrorCode ? <p className="mt-2 break-all text-xs text-[#9d3128]">{destination.lastErrorCode}</p> : null}</div><div className="flex flex-wrap gap-2"><SmallButton onClick={() => edit(destination)}>编辑</SmallButton><SmallButton disabled={busy === "verify-destination"} onClick={() => onPost({ action: "verify-destination", destinationId: destination.id }, "目标权限验证完成")}>验证配置</SmallButton><SmallButton disabled={busy === "test-destination"} onClick={() => test(destination)}>发送测试消息</SmallButton></div></div></div>)}</div>}</Card>
  </div>;
}

function SystemHealth({ data, busy, onPost }) {
  const [showAllLogs, setShowAllLogs] = useState(false);
  const health = data.health || {};
  const speaker = health.speakerBot || {};
  const scheduler = health.scheduler || {};
  const releaseReady = Boolean(
    health.database?.ok
    && speaker.ok
    && health.scheduler?.ok
    && data.metrics.publishReadyTraders
  );
  const schedulerValue = !scheduler.configured
    ? "定时密钥未配置"
    : scheduler.lastRunAt
      ? "调度已运行"
      : "等待首次运行";
  const schedulerDetail = scheduler.lastRunAt
    ? `上次 ${formatDate(scheduler.lastRunAt)}`
    : scheduler.errorCode || "尚无记录";
  const webhookDetail = speaker.webhookConfigured
    ? speaker.webhookMatchesDeployment
      ? `Webhook 正常 · 待处理 ${speaker.pendingUpdates || 0}`
      : "Webhook 指向其他部署，请重新配置"
    : speaker.errorCode || "Webhook 未配置";
  const previewNotice = speaker.environment === "preview"
    ? "预览环境必须使用独立测试 Bot，系统不会复用或覆盖正式 SpeakerBot 的 Webhook。"
    : "正式环境只会把 SpeakerBot Webhook 配置到当前正式地址。";
  const visibleLogs = showAllLogs ? data.logs : data.logs.slice(0, 20);
  return <div className="grid gap-5">
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <HealthCard title="数据库" ok={health.database?.ok} value={health.database?.ok ? "连接正常" : "连接异常"} detail={health.database?.driver || health.database?.errorCode || "未配置"} />
      <HealthCard title="SpeakerBot" ok={speaker.ok} value={speaker.username ? `@${speaker.username}` : speaker.configured ? "已配置" : "未配置"} detail={webhookDetail} />
      <HealthCard title="订单追踪" ok={scheduler.ok} value={schedulerValue} detail={schedulerDetail} />
      <HealthCard title="上线准备" ok={releaseReady} value={`${data.metrics.orderReadyTraders || 0} Trader 核验就绪`} detail={releaseReady ? `${data.metrics.publishReadyTraders || 0} 名 Trader 可完整发布` : data.metrics.orderReadyTraders ? "订单核验已就绪，发布目标待配置" : "数据库、Bot、定时追踪和 Trader 账户关联必须全部正常"} />
    </div>
    <Card className="p-5 md:p-6">
      <SectionHead title="SpeakerBot 接收入口" desc="Webhook 只接收 SpeakerBot 私聊消息，并校验 Telegram Secret Token。不会在页面展示 Bot Token 或 API Secret。" />
      <div className="mt-4 rounded-lg border border-[#e7c883] bg-[#fff9e9] p-4 text-sm leading-6 text-[#6f551d]">{previewNotice}{speaker.expectedWebhookUrl ? <p className="mt-2 break-all font-mono text-xs">目标：{speaker.expectedWebhookUrl}</p> : null}</div>
      <button className="mt-4 min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={busy === "configure-webhook" || !speaker.configurationAllowed} onClick={() => { if (window.confirm(`确认将 SpeakerBot Webhook 配置到 ${speaker.expectedWebhookUrl || "当前线上地址"}？`)) onPost({ action: "configure-webhook" }, "SpeakerBot Webhook 配置成功"); }} type="button">{busy === "configure-webhook" ? "配置中…" : "配置 SpeakerBot Webhook"}</button>
      {!speaker.configurationAllowed ? <p className="mt-3 text-xs font-bold text-[#9d3128]">当前不可配置：{speaker.errorCode || "环境配置不完整"}</p> : null}
    </Card>
    <Card className="p-5 md:p-6"><SectionHead title="最近管理操作" desc={`账户凭证不会写入操作日志。${data.logs.length > 20 && !showAllLogs ? "默认显示最近 20 条。" : ""}`} />{!data.logs.length ? <Empty text="暂无管理操作记录。" /> : <><div className="mt-4 overflow-x-auto"><table className="min-w-[720px] w-full text-left text-sm"><thead><tr><Th>时间</Th><Th>操作</Th><Th>对象</Th><Th>结果</Th></tr></thead><tbody>{visibleLogs.map((log, index) => <tr className="border-t border-ops-line" key={log.id || `${log.createdAt}-${index}`}><Td>{formatDate(log.createdAt || log.at)}</Td><Td>{auditLabel(log.action)}</Td><Td><span className="break-all font-mono text-xs">{log.entityId || log.targetId || "—"}</span></Td><Td>{log.errorCode || "完成"}</Td></tr>)}</tbody></table></div>{data.logs.length > 20 ? <SmallButton className="mt-4" onClick={() => setShowAllLogs((current) => !current)}>{showAllLogs ? "收起" : "显示全部"}</SmallButton> : null}</>}</Card>
  </div>;
}

function HealthCard({ title, ok, value, detail }) { return <Card className="min-w-0 p-5"><div className="flex items-center justify-between gap-3"><strong>{title}</strong><StatusPill tone={ok ? "green" : "amber"}>{ok ? "正常" : "检查"}</StatusPill></div><p className="mt-4 break-all text-xl font-black leading-tight">{value}</p><p className="mt-2 break-all text-xs leading-5 text-ops-muted">{detail}</p></Card>; }
function SectionHead({ title, desc }) { return <div><h2 className="text-lg font-black">{title}</h2><p className="mt-1 text-sm leading-6 text-ops-muted">{desc}</p></div>; }
function Empty({ text }) { return <div className="py-10 text-center text-sm font-bold text-ops-muted">{text}</div>; }
function Fact({ label, value }) { return <div className="rounded-lg border border-ops-line bg-[#fbfcfb] p-3"><p className="text-xs font-bold text-ops-muted">{label}</p><p className="mt-1 break-all font-black">{value}</p></div>; }
function FormActions({ busy, disabled = false, editing, onCancel }) { return <div className="flex flex-wrap gap-2"><button className="min-h-11 rounded-lg bg-ops-accent px-5 text-sm font-black text-white disabled:opacity-50" disabled={busy || disabled} type="submit">{busy ? "保存中…" : editing ? "保存修改" : "保存"}</button>{editing ? <button className="min-h-11 rounded-lg border border-ops-line px-5 text-sm font-black" onClick={onCancel} type="button">取消编辑</button> : null}</div>; }
function SmallButton({ children, className = "", ...props }) { return <button className={`min-h-9 rounded-lg border border-ops-line bg-white px-3 text-xs font-black text-[#33423b] disabled:opacity-50 ${className}`} type="button" {...props}>{children}</button>; }
function Th({ children }) { return <th className="px-4 py-3 font-black">{children}</th>; }
function Td({ children, className = "" }) { return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>; }

function groupTopicOptions(groups) {
  return groups.flatMap((group) => normalizeDistributionGroupTopics(group).filter((topic) => Number(topic.threadId || topic.topicId) > 0).map((topic) => {
    const target = { chatId: String(group.chatId), threadId: Number(topic.threadId || topic.topicId), chatTitle: group.title || group.name || "", topicTitle: topic.name || topic.title || "" };
    return { key: `${target.chatId}:${target.threadId}`, label: `${target.chatTitle} / ${target.topicTitle}`, target };
  }));
}
function toggleValue(values, value) { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function formatDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function money(value) { if (value === null || value === undefined || value === "") return "—"; const number = Number(value); return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDT` : "—"; }
function percent(value) { if (value === null || value === undefined || value === "") return "—"; const number = Number(value); return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "—"; }
function directionLabel(value) { return String(value || "").toLowerCase() === "sell" || String(value || "").toLowerCase() === "short" ? "Short" : "Long"; }
function signalTone(status) { return ["closed_profit", "tracking"].includes(status) ? "green" : "amber"; }
function signalStatus(status) { return ({ tracking: "追踪中", closed_profit: "盈利已结算", closed_loss: "亏损已结算", needs_review: "需要复核", rejected: "已拒绝", verified: "已核验", pending: "待核验" })[status] || status || "未知"; }
function traderReadiness(trader) {
  if (trader.status !== "enabled") return { label: "已停用", tone: "amber" };
  if (trader.canPublish) return { label: "全流程已就绪", tone: "green" };
  if (trader.canVerifyOrders) return { label: "订单核验已就绪", tone: "green" };
  if (!trader.telegramReady) return { label: "Telegram 身份待完善", tone: "amber" };
  if (trader.linkedAccountCount) return { label: "YUBIT 账户待验证", tone: "amber" };
  return { label: "YUBIT 账户待关联", tone: "amber" };
}
function accountStatus(status) { return ({ pending: "待验证", verified: "已验证", invalid: "验证失败", disabled: "已停用" })[status] || status || "未知"; }
function yubitAccountError(value) {
  const error = String(value || "");
  const messages = [
    ["26200002", "YUBIT 请求时间校验失败，请稍后重试；若持续出现请检查服务器时间。"],
    ["26200003", "API Key 无效，请确认粘贴的是当前 YUBIT 账户创建的 Key。"],
    ["26200004", "API 签名不匹配，请重新粘贴同一组 API Key 和 API Secret；系统会自动去除复制时带入的首尾空格。"],
    ["26200005", "YUBIT 查询权限不足，请为该 API Key 开启订单只读查询权限，并保持交易、转账和提现权限关闭。"],
    ["26200006", "YUBIT 请求过于频繁，请稍后再验证。"],
    ["26200012", "生产服务器公网 IP 尚未加入该 API Key 的白名单，请在 YUBIT API 设置中补充后重新验证。"],
    ["26200013", "API Key 已过期，请在 YUBIT 重新创建只读凭证。"],
    ["26200030", "YUBIT 上游服务暂时异常，请稍后重新验证。"],
    ["YUBIT_NETWORK_ERROR", "生产服务器暂时无法连接 YUBIT OpenAPI，请检查网络后重试。"],
    ["YUBIT_TIMEOUT", "YUBIT OpenAPI 响应超时，请稍后重新验证。"],
  ];
  const match = messages.find(([code]) => error.includes(code));
  return match ? `${match[1]}（${match[0]}）` : error;
}
function deliveryStatus(status) { return ({ pending: "待发送", sending: "发送中", delivered: "已送达", failed: "发送失败" })[status] || status || "未知"; }
function publicationLabel(value) { return value === "pnl_card" ? "盈利 PNL 卡片" : "交易信号"; }
function eventLabel(value) { return ({ verified: "订单已核验", tracking_started: "开始持续追踪", order_updated: "订单状态更新", closed_profit: "盈利结算", closed_loss: "亏损结算", needs_review: "转人工复核", published: "信号已发布" })[value] || value || "状态更新"; }
function auditLabel(value) { return ({ "save-trader": "保存 Trader", "save-account": "保存账户", "verify-account": "验证账户", "save-destination": "保存发布目标", "verify-destination": "验证发布目标", "test-destination": "发送测试消息" })[value] || value || "系统操作"; }
