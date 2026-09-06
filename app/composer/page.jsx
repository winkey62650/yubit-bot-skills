"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import ConsoleShell from "../components/ConsoleShell";
import { useLanguage } from "../components/LanguageProvider";
import { useSession } from "../components/SessionProvider";
import { Card, PageHeader, Field, inputClass } from "../components/ui";
import {
  buildAccountTargetGroups,
  filterTelegramComposerTargets
} from "../../lib/telegram-composer-targets.mjs";
import { applyComposerTargetFolder } from "../../lib/composer-target-folders.mjs";

export default function ComposerPage() {
  const { t } = useLanguage();
  const { user } = useSession();
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [configuredGroups, setConfiguredGroups] = useState([]);
  const [targetFolders, setTargetFolders] = useState([]);
  const [targetFolderName, setTargetFolderName] = useState("");
  const [targetFolderBusy, setTargetFolderBusy] = useState(false);
  const [loadErrors, setLoadErrors] = useState([]);
  const [loadVersion, setLoadVersion] = useState(0);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState("");
  
  // Form state
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedTargets, setSelectedTargets] = useState([]);
  const [messageText, setMessageText] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [targetSearch, setTargetSearch] = useState("");
  
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  
  const fileInputRef = useRef(null);
  const dialogRequestRef = useRef(0);
  const dialogControllerRef = useRef(null);
  const translateRef = useRef(t);
  translateRef.current = t;

  const loadUserDialogs = useCallback(async (
    userId,
    currentConfiguredGroups = [],
    { resetSelection = true, silent = false } = {}
  ) => {
    // A slow permission check must finish before the next background refresh.
    if (silent && dialogControllerRef.current) return;
    dialogControllerRef.current?.abort();
    const controller = new AbortController();
    dialogControllerRef.current = controller;
    const requestId = ++dialogRequestRef.current;
    if (resetSelection) setSelectedTargets([]);
    if (!silent) setGroups([]);
    if (!silent) setError("");
    if (!userId) {
      setTargetsLoading(false);
      setLastCheckedAt("");
      dialogControllerRef.current = null;
      return;
    }
    if (!silent) setTargetsLoading(true);
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const res = await fetch(`/api/telegram/dialogs?userId=${encodeURIComponent(userId)}`, { signal: controller.signal });
      const data = await res.json();
      if (!res.ok || !data.ok || !Array.isArray(data.groups)) {
        throw new Error(data.error || translateRef.current("composer.dialogError"));
      }
      if (requestId === dialogRequestRef.current) {
        const nextGroups = buildAccountTargetGroups(currentConfiguredGroups, data.groups);
        const writableTargetIds = new Set();
        for (const group of nextGroups) {
          if (group.isForum) {
            for (const topic of group.topics || []) {
              if (topic.canSendMessages === true) writableTargetIds.add(`${group.chatId}:${topic.threadId}`);
            }
          } else if (group.canSendMessages === true) {
            writableTargetIds.add(`${group.chatId}:`);
          }
        }
        setGroups(nextGroups);
        setSelectedTargets((current) => current.filter((id) => writableTargetIds.has(id)));
        setLastCheckedAt(new Date().toISOString());
      }
    } catch (err) {
      console.error("Failed to fetch dialogs", err);
      if (requestId === dialogRequestRef.current) {
        setGroups([]);
        setSelectedTargets([]);
        setLastCheckedAt("");
        setError(err.name === "AbortError" ? translateRef.current("composer.loadTimeout") : err.message || translateRef.current("composer.dialogError"));
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestId === dialogRequestRef.current) {
        dialogControllerRef.current = null;
        setTargetsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    async function loadData() {
      setLoading(true);
      setLoadErrors([]);
      const endpoints = [
        ["/api/telegram/user-authorization", "composer.accountLoadError"],
        ["/api/group-config", "composer.groupsLoadError"],
        ["/api/composer/target-folders", "composer.folderLoadError"]
      ];
      const results = await Promise.allSettled(endpoints.map(async ([url, errorKey]) => {
        try {
          const response = await fetch(url, { signal: controller.signal });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || translateRef.current(errorKey));
          return data;
        } catch (error) {
          throw new Error(`${translateRef.current(errorKey)}: ${error.name === "AbortError" ? translateRef.current("composer.loadTimeout") : error.message}`);
        }
      }));
      window.clearTimeout(timeout);
      if (!active) return;
      setLoadErrors(results.filter((result) => result.status === "rejected").map((result) => result.reason.message));
      const [authData, groupsData, foldersData] = results.map((result) => result.status === "fulfilled" ? result.value : null);
      const nextAccounts = Array.isArray(authData?.accounts) ? authData.accounts : [];
      const savedGroups = Array.isArray(groupsData?.groups) ? groupsData.groups : [];
      setAccounts(nextAccounts);
      setConfiguredGroups(savedGroups);
      if (foldersData) setTargetFolders(foldersData.folders || []);
      const initialUserId = nextAccounts[0]?.userId || "";
      setSelectedUserId(initialUserId);
      await loadUserDialogs(initialUserId, savedGroups);
      if (active) setLoading(false);
    }
    loadData();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      ++dialogRequestRef.current;
      dialogControllerRef.current?.abort();
      dialogControllerRef.current = null;
    };
  }, [loadUserDialogs, loadVersion]);

  useEffect(() => {
    if (!selectedUserId || loading) return undefined;
    const timer = window.setInterval(() => {
      loadUserDialogs(selectedUserId, configuredGroups, { resetSelection: false, silent: true });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [configuredGroups, loadUserDialogs, loading, selectedUserId]);

  const targetGroups = groups.map(group => {
    const options = [];
    if (group.isForum) {
      (group.topics || [])
        .filter(topic => topic.threadId !== null && topic.threadId !== undefined && Number.isInteger(Number(topic.threadId)) && Number(topic.threadId) > 0)
        .forEach(topic => {
        options.push({
          id: `${group.chatId}:${topic.threadId}`,
          label: topic.liveName || topic.name,
          available: topic.canSendMessages === true,
          status: topic.availabilityStatus || "unknown"
        });
      });
    } else {
      options.push({
        id: `${group.chatId}:`,
        label: t("composer.mainDestination"),
        available: group.canSendMessages === true,
        status: group.canSendMessages === true ? "available" : "unknown"
      });
    }
    return {
      chatId: group.chatId,
      title: group.title,
      topicStatusError: group.topicStatusError,
      publishUnavailableReason: group.publishUnavailableReason,
      options
    };
  });
  const targetOptions = targetGroups.flatMap((group) => group.options);
  const filteredTargetGroups = useMemo(
    () => filterTelegramComposerTargets(targetGroups, targetSearch),
    [targetGroups, targetSearch]
  );

  const handleTargetToggle = (id) => {
    if (!targetOptions.find((option) => option.id === id)?.available) return;
    setSelectedTargets((prev) => 
      prev.includes(id) 
        ? prev.filter((t) => t !== id) 
        : [...prev, id]
    );
  };

  const handleGroupToggle = (options, checked) => {
    const writableIds = options
      .filter((option) => option.available)
      .map((option) => option.id);
    setSelectedTargets((prev) => checked
      ? [...new Set([...prev, ...writableIds])]
      : prev.filter((id) => !writableIds.includes(id))
    );
  };

  async function saveTargetFolder() {
    const name = targetFolderName.trim();
    if (!name || selectedTargets.length === 0) return;
    const targetLookup = new Map(targetGroups.flatMap((group) => group.options.map((option) => [
      option.id,
      { id: option.id, groupTitle: group.title, topicTitle: option.label }
    ])));
    setTargetFolderBusy(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/composer/target-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          folder: { name, targets: selectedTargets.map((id) => targetLookup.get(id)).filter(Boolean) }
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || t("composer.folderSaveError"));
      setTargetFolders(data.folders || []);
      setTargetFolderName("");
      setSuccess(t("composer.folderSaved", { name }));
    } catch (err) {
      setError(err.message || t("composer.folderSaveError"));
    } finally {
      setTargetFolderBusy(false);
    }
  }

  function applyTargetFolder(folder) {
    const result = applyComposerTargetFolder(
      folder,
      targetOptions.filter((option) => option.available).map((option) => option.id)
    );
    setSelectedTargets(result.selectedTargetIds);
    setError("");
    if (result.selectedTargetIds.length === 0) {
      setSuccess("");
      setError(t("composer.folderUnavailable"));
      return;
    }
    setSuccess(t("composer.folderApplied", {
      name: folder.name,
      count: result.selectedTargetIds.length,
      skipped: result.unavailableTargets.length
    }));
  }

  async function deleteTargetFolder(folder) {
    if (!window.confirm(t("composer.folderDeleteConfirm", { name: folder.name }))) return;
    setTargetFolderBusy(true);
    setError("");
    try {
      const res = await fetch("/api/composer/target-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: folder.id })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || t("composer.folderDeleteError"));
      setTargetFolders(data.folders || []);
      setSuccess(t("composer.folderDeleted", { name: folder.name }));
    } catch (err) {
      setError(err.message || t("composer.folderDeleteError"));
    } finally {
      setTargetFolderBusy(false);
    }
  }

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(prev => [...prev, ...files]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const moveFile = (index, direction) => {
    const newFiles = [...selectedFiles];
    if (direction === "up" && index > 0) {
      [newFiles[index - 1], newFiles[index]] = [newFiles[index], newFiles[index - 1]];
    } else if (direction === "down" && index < newFiles.length - 1) {
      [newFiles[index + 1], newFiles[index]] = [newFiles[index], newFiles[index + 1]];
    }
    setSelectedFiles(newFiles);
  };

  async function handleSend(queue = false) {
    if (!selectedUserId) {
      setError(t("composer.selectAccountError"));
      return;
    }
    if (selectedTargets.length === 0) {
      setError(t("composer.selectTargetError"));
      return;
    }
    if (!messageText.trim() && selectedFiles.length === 0) {
      setError(t("composer.contentError"));
      return;
    }

    setSending(true);
    setError("");
    setSuccess("");

    try {
      const formData = new FormData();
      formData.append("userId", selectedUserId);
      formData.append("text", messageText);
      formData.append("queue", String(queue));
      
      if (selectedFiles.length > 0) {
        for (let i = 0; i < selectedFiles.length; i++) {
          formData.append("media", selectedFiles[i]);
        }
      }
      
      selectedTargets.forEach((t) => formData.append("targets", t));

      const res = await fetch("/api/composer/send", {
        method: "POST",
        body: formData
      });
      const data = await res.json();
      
      if (!res.ok || !data.ok) {
        if (data.partial && Array.isArray(data.results)) {
          const delivered = new Set(data.results.map((result) => result.target));
          setSelectedTargets((current) => current.filter((target) => !delivered.has(target)));
        }
        throw new Error(data.error || t("composer.sendError"));
      }
      
      setSuccess(data.warning || (queue ? t("composer.queued") : t("composer.sent")));
      setMessageText("");
      setSelectedFiles([]);
      setSelectedTargets([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader
        title={t("composer.title")}
        desc={t("composer.desc")}
      />
      
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(340px,2fr)] items-start">
        <Card className="min-w-0 p-4 sm:p-6">
          {loading ? (
            <p className="text-ops-muted">{t("common.loading")}</p>
          ) : (
            <div className="space-y-5">
              {loadErrors.length > 0 && <div role="alert" className="rounded-lg bg-[#fef5f4] p-3 text-[#a04a3d]">
                {loadErrors.map((message) => <p key={message}>{message}</p>)}
                <button type="button" className="mt-2 font-bold underline" onClick={() => setLoadVersion((value) => value + 1)}>{t("composer.retryLoad")}</button>
              </div>}
              {error && <div role="alert" className="p-3 bg-[#fef5f4] text-[#a04a3d] font-bold rounded-lg">{error}</div>}
              {success && <div className="p-3 bg-[#f3f9f4] text-[#2c7a3f] font-bold rounded-lg">{success}</div>}
              
              <Field label={t("composer.account")}>
                <select 
                  className={inputClass}
                  value={selectedUserId}
                  onChange={(e) => {
                    const newUserId = e.target.value;
                    setSelectedUserId(newUserId);
                    setSuccess("");
                    loadUserDialogs(newUserId, configuredGroups);
                  }}
                  disabled={sending || accounts.length === 0}
                >
                  <option value="">{t("composer.accountPlaceholder")}</option>
                  {accounts.map(acc => (
                    <option key={acc.userId} value={acc.userId}>
                      {acc.firstName} {acc.lastName} (@{acc.username || acc.userId})
                    </option>
                  ))}
                </select>
                {accounts.length === 0 && (
                  <p className="mt-1 text-sm text-[#a04a3d]">{t("composer.noAccount")}</p>
                )}
              </Field>

              <Field label={t("composer.body")}>
                <textarea 
                  className={`${inputClass} min-h-[150px]`}
                  placeholder={t("composer.bodyPlaceholder")}
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  disabled={sending}
                />
              </Field>

              <div className="rounded-xl border border-[#cae5da] bg-[#f2faf6] p-4">
                <h2 className="text-sm font-black text-[#173f31]">频道 CTA 配置</h2>
                <p className="mt-1 text-xs leading-5 text-[#41564d]">发送前会按所选 Telegram 群组或频道读取共用 CTA；同一群内所有 Topic 使用相同配置，并追加到对应消息末尾。</p>
                {user?.role === "admin" ? <Link className="mt-3 inline-flex text-xs font-black text-ops-accent hover:underline" href="/distribution?view=destination-cta">管理频道 CTA →</Link> : <p className="mt-2 text-xs font-bold text-ops-muted">如需修改，请联系管理员在内容分发中心维护。</p>}
              </div>

              <Field label={t("composer.media")}>
                <div className="flex flex-col gap-3">
                  <input 
                    type="file" 
                    multiple
                    onChange={handleFileChange}
                    className="block w-full text-sm text-slate-500
                      file:mr-4 file:py-2 file:px-4
                      file:rounded-full file:border-0
                      file:text-sm file:font-semibold
                      file:bg-ops-soft file:text-ops-accent
                      hover:file:bg-ops-soft/80" 
                    ref={fileInputRef}
                    disabled={sending}
                    accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                  />
                  <p className="text-xs text-ops-muted">{t("composer.mediaHint")}</p>
                  
                  {selectedFiles.length > 0 && (
                    <div className="flex flex-col gap-2 mt-2 bg-gray-50 rounded-lg p-3 border border-gray-200">
                      {selectedFiles.map((f, i) => (
                        <div key={i} className="flex items-center justify-between bg-white border border-gray-200 p-2 rounded">
                          <span className="text-sm font-bold truncate max-w-[200px] sm:max-w-xs">{f.name}</span>
                          <div className="flex items-center gap-1">
                            <button 
                              onClick={() => moveFile(i, "up")} 
                              disabled={i === 0 || sending}
                              className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
                              title={t("common.moveUp")}
                            >↑</button>
                            <button 
                              onClick={() => moveFile(i, "down")} 
                              disabled={i === selectedFiles.length - 1 || sending}
                              className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
                              title={t("common.moveDown")}
                            >↓</button>
                            <button 
                              onClick={() => removeFile(i)} 
                              disabled={sending}
                              className="px-2 py-1 text-xs bg-red-100 text-red-600 hover:bg-red-200 rounded disabled:opacity-50 ml-2"
                              title={t("common.delete")}
                            >✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Field>

              <div className="flex gap-3 pt-2">
                <button 
                  onClick={() => handleSend(false)} 
                  disabled={sending || !selectedUserId || selectedTargets.length === 0 || (!messageText.trim() && selectedFiles.length === 0)}
                  className="rounded-lg bg-ops-accent px-5 py-2 font-black text-white disabled:opacity-50"
                >
                  {sending ? t("composer.processing") : t("composer.send")}
                </button>
                {user?.role === "admin" ? (
                  <button
                    onClick={() => handleSend(true)}
                    disabled={sending || !selectedUserId || selectedTargets.length === 0 || (!messageText.trim() && selectedFiles.length === 0)}
                    className="rounded-lg bg-[#f0f2f5] px-5 py-2 font-black text-ops-muted hover:bg-[#e4e6eb] transition-colors disabled:opacity-50"
                  >
                    {t("composer.queue")}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </Card>

        <Card className="min-w-0 p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-black">{t("composer.targets")}</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => loadUserDialogs(selectedUserId, configuredGroups, { resetSelection: false })}
                disabled={!selectedUserId || sending || targetsLoading}
                className="text-xs text-ops-accent hover:underline bg-ops-soft px-3 py-1.5 rounded-full font-bold disabled:opacity-50"
              >
                {targetsLoading ? t("composer.refreshingTargets") : t("composer.refreshTargets")}
              </button>
              {user?.role === "admin" ? (
                <Link
                  href="/group-config"
                  className="text-xs text-ops-accent hover:underline bg-ops-soft px-3 py-1.5 rounded-full font-bold"
                >
                  {t("composer.manageGroups")}
                </Link>
              ) : null}
            </div>
          </div>

          <div className="mb-4 rounded-xl border border-[#cae5da] bg-[#f2faf6] p-3">
            <div className="text-sm font-black text-[#173f31]">{t("composer.folderTitle")}</div>
            <p className="mt-1 text-xs leading-5 text-[#41564d]">{t("composer.folderHint")}</p>
            <div className="mt-3 flex gap-2">
              <input
                className={`${inputClass} min-w-0 flex-1`}
                value={targetFolderName}
                onChange={(event) => setTargetFolderName(event.target.value)}
                placeholder={t("composer.folderNamePlaceholder")}
                maxLength={60}
                disabled={sending || targetFolderBusy}
              />
              <button
                type="button"
                onClick={saveTargetFolder}
                disabled={sending || targetFolderBusy || !targetFolderName.trim() || selectedTargets.length === 0}
                className="shrink-0 rounded-lg bg-[#173f31] px-3 py-2 text-xs font-black text-white disabled:opacity-50"
              >
                {t("composer.folderSave")}
              </button>
            </div>
            {targetFolders.length > 0 ? (
              <div className="mt-3 space-y-2">
                {targetFolders.map((folder) => (
                  <div key={folder.id} className="flex items-center gap-2 rounded-lg border border-[#cae5da] bg-white p-2">
                    <button
                      type="button"
                      onClick={() => applyTargetFolder(folder)}
                      disabled={sending || targetFolderBusy || targetsLoading || !selectedUserId}
                      className="min-w-0 flex-1 text-left disabled:opacity-50"
                    >
                      <span className="block truncate text-sm font-black">{folder.name}</span>
                      <span className="block text-xs text-ops-muted">{t("composer.folderTargetCount", { count: folder.targets.length })}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTargetFolder(folder)}
                      disabled={sending || targetFolderBusy}
                      className="rounded px-2 py-1 text-xs font-bold text-[#a04a3d] hover:bg-[#fef5f4] disabled:opacity-50"
                      aria-label={t("composer.folderDelete", { name: folder.name })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-ops-muted">{t("composer.folderEmpty")}</p>
            )}
          </div>
          
          {targetsLoading ? (
            <div className="text-sm text-ops-muted p-4 bg-gray-50 rounded-lg text-center">
              {t("composer.loadingTargets")}
            </div>
          ) : targetGroups.length === 0 ? (
            <div className="text-sm text-ops-muted p-4 bg-gray-50 rounded-lg text-center">
              <p className="font-bold mb-2">{t("composer.noTargets")}</p>
              <p className="text-xs">{t("composer.noTargetsHint")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label={t("composer.targetSearch")}>
                <input
                  type="search"
                  className={inputClass}
                  value={targetSearch}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder={t("composer.targetSearchPlaceholder")}
                  disabled={sending || targetsLoading}
                />
              </Field>

              {filteredTargetGroups.length === 0 ? (
                <div className="rounded-lg bg-gray-50 p-4 text-center text-sm text-ops-muted">
                  {t("composer.noSearchResults")}
                </div>
              ) : (
                <div className="flex max-h-[500px] flex-col gap-2 overflow-y-auto pr-2">
              {filteredTargetGroups.map((group) => {
                const groupAvailableTargets = group.options.filter((option) => option.available);
                const selectedInGroup = groupAvailableTargets.filter((option) => selectedTargets.includes(option.id)).length;
                const allSelected = groupAvailableTargets.length > 0 && selectedInGroup === groupAvailableTargets.length;

                return (
                  <details key={group.chatId}
                    open={targetSearch.trim() ? true : undefined}
                    className="group rounded-xl border border-ops-line bg-white open:shadow-sm"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-3 hover:bg-[#f7faf8] [&::-webkit-details-marker]:hidden">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-black">{group.title}</div>
                        <div className="mt-1 text-xs text-ops-muted">
                          {t("composer.groupAvailability", { available: groupAvailableTargets.length, total: group.options.length })}
                        </div>
                      </div>
                      <span className="shrink-0 text-ops-muted transition-transform group-open:rotate-180" aria-hidden="true">⌄</span>
                    </summary>

                    <div className="border-t border-ops-line px-3 py-2">
                      {group.publishUnavailableReason && <p className="py-2 text-xs text-[#a04a3d]">{t(`composer.permission.${group.publishUnavailableReason}`)}</p>}
                      {group.options.length === 0 && <p className="py-2 text-xs text-[#a04a3d]">{t("composer.noVerifiedTopics")}</p>}
                      {group.topicStatusError && <p role="alert" className="py-2 text-xs text-[#a04a3d]">{t("composer.topicCheckError")}: {group.topicStatusError}</p>}
                      {groupAvailableTargets.length > 1 ? (
                        <label className="mb-1 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-[#f7faf8]">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={(event) => handleGroupToggle(group.options, event.target.checked)}
                            disabled={sending || targetsLoading}
                          />
                          <span className="text-xs font-bold">{t("composer.selectGroup")}</span>
                        </label>
                      ) : null}

                      {group.options.map((opt) => (
                        <label key={opt.id} className={`flex items-start gap-3 rounded-lg p-2 transition ${opt.available ? "cursor-pointer hover:bg-[#f7faf8]" : "cursor-not-allowed opacity-55"}`}>
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={selectedTargets.includes(opt.id)}
                            onChange={() => handleTargetToggle(opt.id)}
                            disabled={sending || targetsLoading || !opt.available}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-bold">{opt.label}</div>
                            <div className={`mt-1 text-xs font-bold ${opt.available ? "text-[#2c7a3f]" : "text-[#a04a3d]"}`}>
                              {t(`composer.topicStatus.${opt.status}`)}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </details>
                );
              })}
                </div>
              )}
            </div>
          )}
          <p className="mt-4 text-xs text-ops-muted">{t("composer.selectionHint", { count: selectedTargets.length })}</p>
          <p className="mt-1 text-xs text-ops-muted">
            {t("composer.liveCheckHint")}
            {lastCheckedAt ? ` · ${t("composer.lastChecked", { time: new Date(lastCheckedAt).toLocaleTimeString() })}` : ""}
          </p>
        </Card>
      </div>
    </ConsoleShell>
  );
}
