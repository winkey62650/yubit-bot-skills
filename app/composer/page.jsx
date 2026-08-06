"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import Link from "next/link";
import ConsoleShell from "../components/ConsoleShell";
import { useLanguage } from "../components/LanguageProvider";
import { useSession } from "../components/SessionProvider";
import { Card, PageHeader, Field, inputClass } from "../components/ui";
import { buildAccountTargetGroups } from "../../lib/telegram-composer-targets.mjs";

export default function ComposerPage() {
  const { t } = useLanguage();
  const { user } = useSession();
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [configuredGroups, setConfiguredGroups] = useState([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState("");
  
  // Form state
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedTargets, setSelectedTargets] = useState([]);
  const [messageText, setMessageText] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  
  const fileInputRef = useRef(null);
  const dialogRequestRef = useRef(0);

  const loadUserDialogs = useCallback(async (
    userId,
    currentConfiguredGroups = [],
    { resetSelection = true, silent = false } = {}
  ) => {
    const requestId = ++dialogRequestRef.current;
    if (resetSelection) setSelectedTargets([]);
    if (!silent) setGroups([]);
    setError("");
    if (!userId) {
      setTargetsLoading(false);
      setLastCheckedAt("");
      return;
    }
    if (!silent) setTargetsLoading(true);
    try {
      const res = await fetch(`/api/telegram/dialogs?userId=${userId}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !Array.isArray(data.groups)) {
        throw new Error(data.error || t("composer.dialogError"));
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
        setError(err.message || t("composer.dialogError"));
      }
    } finally {
      if (requestId === dialogRequestRef.current && !silent) setTargetsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    async function loadData() {
      try {
        const [authRes, groupsRes] = await Promise.all([
          fetch("/api/telegram/user-authorization"),
          fetch("/api/group-config")
        ]);
        
        const authData = await authRes.json();
        const groupsData = await groupsRes.json();
        
        let initialUserId = "";
        if (authData.ok) {
          setAccounts(authData.accounts || []);
          if (authData.accounts?.length > 0) {
            initialUserId = authData.accounts[0].userId;
            setSelectedUserId(initialUserId);
          }
        }
        
        const savedGroups = groupsData.ok ? (groupsData.groups || []) : [];
        setConfiguredGroups(savedGroups);
        setGroups([]);

        if (initialUserId) {
          await loadUserDialogs(initialUserId, savedGroups);
        }
      } catch (err) {
        console.error("Failed to load composer data", err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [loadUserDialogs]);

  useEffect(() => {
    if (!selectedUserId || loading) return undefined;
    const timer = window.setInterval(() => {
      loadUserDialogs(selectedUserId, configuredGroups, { resetSelection: false, silent: true });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [configuredGroups, loadUserDialogs, loading, selectedUserId]);

  const targetOptions = [];
  groups.forEach(group => {
    if (group.isForum && group.topics && group.topics.length > 0) {
      group.topics
        .filter(topic => topic.threadId !== null && topic.threadId !== undefined && String(topic.threadId).trim() !== "")
        .forEach(topic => {
        targetOptions.push({
          id: `${group.chatId}:${topic.threadId}`,
          label: `${group.title} - ${topic.liveName || topic.name}`,
          available: topic.canSendMessages === true,
          status: topic.availabilityStatus || "unknown"
        });
      });
    } else {
      targetOptions.push({
        id: `${group.chatId}:`,
        label: group.title,
        available: group.canSendMessages === true,
        status: group.canSendMessages === true ? "available" : "unknown"
      });
    }
  });
  const availableTargets = targetOptions.filter((option) => option.available);

  const handleTargetToggle = (id) => {
    if (!targetOptions.find((option) => option.id === id)?.available) return;
    setSelectedTargets((prev) => 
      prev.includes(id) 
        ? prev.filter((t) => t !== id) 
        : [...prev, id]
    );
  };

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
        throw new Error(data.error || t("composer.sendError"));
      }
      
      setSuccess(queue ? t("composer.queued") : t("composer.sent"));
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
      
      <div className="grid gap-6 md:grid-cols-[2fr_1fr] items-start">
        <Card className="p-6">
          {loading ? (
            <p className="text-ops-muted">{t("common.loading")}</p>
          ) : (
            <div className="space-y-5">
              {error && <div className="p-3 bg-[#fef5f4] text-[#a04a3d] font-bold rounded-lg">{error}</div>}
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
                  disabled={sending || !selectedUserId || selectedTargets.length === 0 || (!messageText && selectedFiles.length === 0)}
                  className="rounded-lg bg-ops-accent px-5 py-2 font-black text-white disabled:opacity-50"
                >
                  {sending ? t("composer.processing") : t("composer.send")}
                </button>
                {user?.role === "admin" ? (
                  <button
                    onClick={() => handleSend(true)}
                    disabled={sending || !selectedUserId || selectedTargets.length === 0 || (!messageText && selectedFiles.length === 0)}
                    className="rounded-lg bg-[#f0f2f5] px-5 py-2 font-black text-ops-muted hover:bg-[#e4e6eb] transition-colors disabled:opacity-50"
                  >
                    {t("composer.queue")}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-black">{t("composer.targets")}</h2>
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
          
          {targetsLoading ? (
            <div className="text-sm text-ops-muted p-4 bg-gray-50 rounded-lg text-center">
              {t("composer.loadingTargets")}
            </div>
          ) : targetOptions.length === 0 ? (
            <div className="text-sm text-ops-muted p-4 bg-gray-50 rounded-lg text-center">
              <p className="font-bold mb-2">{t("composer.noTargets")}</p>
              <p className="text-xs">{t("composer.noTargetsHint")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto pr-2">
              <div className="flex items-center gap-2 pb-2 border-b border-ops-line mb-2">
                <input 
                  type="checkbox" 
                  id="selectAll"
                  checked={selectedTargets.length === availableTargets.length && availableTargets.length > 0}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedTargets(availableTargets.map(o => o.id));
                    } else {
                      setSelectedTargets([]);
                    }
                  }}
                  disabled={sending || targetsLoading}
                />
                <label htmlFor="selectAll" className="text-sm font-bold cursor-pointer">{t("composer.selectAll")}</label>
              </div>
              
              {targetOptions.map((opt) => (
                <label key={opt.id} className={`flex items-start gap-3 p-2 rounded transition ${opt.available ? "hover:bg-[#f7faf8] cursor-pointer" : "cursor-not-allowed opacity-55"}`}>
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
