"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import ConsoleShell from "../components/ConsoleShell";
import { Card, PageHeader, Field, inputClass } from "../components/ui";
import { buildAccountTargetGroups } from "../../lib/telegram-composer-targets.mjs";

export default function ComposerPage() {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [configuredGroups, setConfiguredGroups] = useState([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  
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
  }, []);

  async function loadUserDialogs(userId, currentConfiguredGroups = []) {
    const requestId = ++dialogRequestRef.current;
    setSelectedTargets([]);
    setGroups([]);
    setError("");
    if (!userId) {
      setTargetsLoading(false);
      return;
    }
    setTargetsLoading(true);
    try {
      const res = await fetch(`/api/telegram/dialogs?userId=${userId}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !Array.isArray(data.groups)) {
        throw new Error(data.error || "读取账号可发言频道失败");
      }
      if (requestId === dialogRequestRef.current) {
        setGroups(buildAccountTargetGroups(currentConfiguredGroups, data.groups));
      }
    } catch (err) {
      console.error("Failed to fetch dialogs", err);
      if (requestId === dialogRequestRef.current) {
        setGroups([]);
        setError(err.message || "读取账号可发言频道失败");
      }
    } finally {
      if (requestId === dialogRequestRef.current) setTargetsLoading(false);
    }
  }

  const targetOptions = [];
  groups.forEach(group => {
    if (group.isForum && group.topics && group.topics.length > 0) {
      group.topics
        .filter(topic => topic.threadId !== null && topic.threadId !== undefined && String(topic.threadId).trim() !== "")
        .forEach(topic => {
        targetOptions.push({
          id: `${group.chatId}:${topic.threadId}`,
          label: `${group.title} - ${topic.name}`
        });
      });
    } else {
      targetOptions.push({
        id: `${group.chatId}:`,
        label: group.title
      });
    }
  });

  const handleTargetToggle = (id) => {
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
      setError("请选择发送账号");
      return;
    }
    if (selectedTargets.length === 0) {
      setError("请选择发送目标");
      return;
    }
    if (!messageText.trim() && selectedFiles.length === 0) {
      setError("请输入消息内容或选择附件");
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
        throw new Error(data.error || "发送失败");
      }
      
      setSuccess(queue ? "消息已加入队列" : "消息发送成功");
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
        title="消息发布中心"
        desc="选择账号和目标，编写消息并发送或加入队列。"
      />
      
      <div className="grid gap-6 md:grid-cols-[2fr_1fr] items-start">
        <Card className="p-6">
          {loading ? (
            <p className="text-ops-muted">加载中...</p>
          ) : (
            <div className="space-y-5">
              {error && <div className="p-3 bg-[#fef5f4] text-[#a04a3d] font-bold rounded-lg">{error}</div>}
              {success && <div className="p-3 bg-[#f3f9f4] text-[#2c7a3f] font-bold rounded-lg">{success}</div>}
              
              <Field label="发送账号">
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
                  <option value="">-- 请选择账号 --</option>
                  {accounts.map(acc => (
                    <option key={acc.userId} value={acc.userId}>
                      {acc.firstName} {acc.lastName} (@{acc.username || acc.userId})
                    </option>
                  ))}
                </select>
                {accounts.length === 0 && (
                  <p className="mt-1 text-sm text-[#a04a3d]">暂无已授权账号，请前往“授权页面”添加。</p>
                )}
              </Field>

              <Field label="消息正文 (支持 Markdown)">
                <textarea 
                  className={`${inputClass} min-h-[150px]`}
                  placeholder="请输入消息内容..."
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  disabled={sending}
                />
              </Field>

              <Field label="附加媒体 / 文件 (支持多选)">
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
                  <p className="text-xs text-ops-muted">可选择多张图片/视频作为组图发送。文本将作为整体 Caption 附在下方。</p>
                  
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
                              title="上移"
                            >↑</button>
                            <button 
                              onClick={() => moveFile(i, "down")} 
                              disabled={i === selectedFiles.length - 1 || sending}
                              className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
                              title="下移"
                            >↓</button>
                            <button 
                              onClick={() => removeFile(i)} 
                              disabled={sending}
                              className="px-2 py-1 text-xs bg-red-100 text-red-600 hover:bg-red-200 rounded disabled:opacity-50 ml-2"
                              title="删除"
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
                  {sending ? "处理中..." : "立即发送"}
                </button>
                <button 
                  onClick={() => handleSend(true)} 
                  disabled={sending || !selectedUserId || selectedTargets.length === 0 || (!messageText && selectedFiles.length === 0)}
                  className="rounded-lg bg-[#f0f2f5] px-5 py-2 font-black text-ops-muted hover:bg-[#e4e6eb] transition-colors disabled:opacity-50"
                >
                  加入队列
                </button>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-black">当前账号可发言的群组/频道</h2>
            <Link 
              href="/group-config" 
              className="text-xs text-ops-accent hover:underline bg-ops-soft px-3 py-1.5 rounded-full font-bold"
            >
              群组管理页
            </Link>
          </div>
          
          {targetsLoading ? (
            <div className="text-sm text-ops-muted p-4 bg-gray-50 rounded-lg text-center">
              正在读取当前账号的发言权限...
            </div>
          ) : targetOptions.length === 0 ? (
            <div className="text-sm text-ops-muted p-4 bg-gray-50 rounded-lg text-center">
              <p className="font-bold mb-2">当前账号暂无可发言目标</p>
              <p className="text-xs">这里只显示所选账号能够真实发言的群组和频道。请检查该账号是否已加入并获得发言权限。</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto pr-2">
              <div className="flex items-center gap-2 pb-2 border-b border-ops-line mb-2">
                <input 
                  type="checkbox" 
                  id="selectAll"
                  checked={selectedTargets.length === targetOptions.length && targetOptions.length > 0}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedTargets(targetOptions.map(o => o.id));
                    } else {
                      setSelectedTargets([]);
                    }
                  }}
                  disabled={sending || targetsLoading}
                />
                <label htmlFor="selectAll" className="text-sm font-bold cursor-pointer">全选 (包括所有 Topics 和频道)</label>
              </div>
              
              {targetOptions.map((opt) => (
                <label key={opt.id} className="flex items-start gap-3 p-2 hover:bg-[#f7faf8] rounded cursor-pointer transition">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedTargets.includes(opt.id)}
                    onChange={() => handleTargetToggle(opt.id)}
                    disabled={sending || targetsLoading}
                  />
                  <div>
                    <div className="text-sm font-bold">{opt.label}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-ops-muted">切换发送账号会重新读取权限并清空旧选择。当前已选择: {selectedTargets.length} 个目标</p>
        </Card>
      </div>
    </ConsoleShell>
  );
}
