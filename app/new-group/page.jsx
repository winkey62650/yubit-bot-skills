"use client";

import { useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../components/ui";
import { defaultTopicTemplate } from "../../templates.mjs";

const defaultTopics = defaultTopicTemplate.map((topic) => [topic.id, topic.emoji, topic.name, topic.attribute, topic.announcement || ""]);

export default function NewGroupPage() {
  const [log, setLog] = useState("准备初始化新群。");
  const [topics, setTopics] = useState(defaultTopics);
  const [groupName, setGroupName] = useState("");
  const [chatId, setChatId] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ active: false, value: 0, label: "等待执行" });

  function updateTopic(index, field, value) {
    setTopics((current) => current.map((topic, topicIndex) => {
      if (topicIndex !== index) return topic;
      const next = [...topic];
      next[field] = value;
      return next;
    }));
  }

  async function run() {
    if (running) return;
    setRunning(true);
    setProgress({ active: true, value: 8, label: "初始化群与 Topic" });
    setLog("正在检查群权限并准备初始化...");
    let currentProgress = 8;
    const timer = window.setInterval(() => {
      currentProgress = Math.min(92, currentProgress + Math.max(1, Math.round((92 - currentProgress) / 8)));
      setProgress({ active: true, value: currentProgress, label: "初始化群与 Topic" });
    }, 3000);

    try {
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scriptId: "newGroup",
          payload: {
            mode: "production",
            groupName,
            chatId,
            topics: topics.map(([id, emoji, name, attribute, announcement]) => ({ id, emoji, name, attribute, announcement }))
          }
        })
      });
      const data = await response.json();
      setProgress({ active: true, value: data.ok ? 100 : 96, label: data.ok ? "执行完成" : "执行结束，请查看结果" });
      setLog([data.ok ? "初始化检查完成" : "初始化检查失败", data.stdout, data.error].filter(Boolean).join("\n\n"));
    } catch (error) {
      setProgress({ active: true, value: 96, label: "执行结束，请查看结果" });
      setLog(`请求失败：${error.message}`);
    } finally {
      window.clearInterval(timer);
      setRunning(false);
    }
  }
  return (
    <ConsoleShell>
      <PageHeader title="新群初始化" desc="输入群名称，确认管理机器人已加入目标群后，一键完成群资料、分区、公告和置顶配置。" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="群名称"><input className={inputClass} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="输入群名称，可留空不修改" /></Field>
            <Field label="管理机器人"><select className={inputClass}><option>YUBITadmin</option><option>MOD1</option></select></Field>
            <Field label="群 ID"><input className={inputClass} value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="-100xxxxxxxxxx" /></Field>
            <Field label="分区模板"><select className={inputClass}><option>模版</option></select></Field>
          </div>
          <Field label="群简介（选填）"><textarea className={`${inputClass} mt-4 min-h-24 py-3`} placeholder="输入群简介内容，可选" /></Field>
          <button
            className="mt-5 rounded-lg bg-ops-accent px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={running}
            onClick={run}
          >
            {running ? "正在设置..." : "批量设置新群"}
          </button>
          {progress.active && (
            <div className="mt-3 rounded-lg border border-ops-line bg-white p-3">
              <div className="flex items-center justify-between text-xs font-black text-ops-muted">
                <span>{progress.label}</span>
                <span>{progress.value}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e7eee9]">
                <div className="h-full rounded-full bg-ops-accent transition-all duration-700" style={{ width: `${progress.value}%` }} />
              </div>
            </div>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="text-lg font-black">初始化清单</h2>
          <div className="mt-4 grid gap-3 text-sm">
            {["设置群资料", "创建分区", "设置公告", "置顶消息"].map((item) => <div className="flex items-center justify-between" key={item}><span>{item}</span><StatusPill>已就绪</StatusPill></div>)}
            <div className="flex items-center justify-between"><span>权限检查</span><StatusPill tone="amber">待执行</StatusPill></div>
          </div>
          <div className="mt-5 border-t border-ops-line pt-5">
            <h3 className="font-black">建群默认关闭话题</h3>
            <div className="mt-3 grid gap-2 text-sm">
              {topics.filter((topic) => topic[3] === "关闭话题").map((topic) => (
                <label className="flex items-center justify-between rounded-lg bg-[#fbfcfb] px-3 py-2" key={topic}>
                  <span>{topic[1]} {topic[2]}</span>
                  <input type="checkbox" defaultChecked />
                </label>
              ))}
            </div>
          </div>
          <pre className="mt-5 max-h-48 overflow-auto rounded-lg bg-[#101815] p-3 text-xs leading-5 text-[#d8f9e7]">{log}</pre>
        </Card>
      </div>
      <Card className="mt-5 overflow-hidden">
        <div className="border-b border-ops-line p-5">
          <h2 className="text-xl font-black">分区模板预览</h2>
          <p className="mt-1 text-sm text-ops-muted">建群前可以直接修改 Topic 名称和属性；关闭话题表示创建后默认关闭该 Topic。</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-[#f9fbfa] text-left text-xs uppercase text-ops-muted">
              <tr><th className="px-5 py-3">序号</th><th className="px-5 py-3">Emoji</th><th className="px-5 py-3">Topic 名称</th><th className="px-5 py-3">属性</th></tr>
            </thead>
            <tbody>
              {topics.map((topic, index) => (
                <tr className="border-t border-ops-line" key={topic[0]}>
                  <td className="px-5 py-3 font-bold">{topic[0]}</td>
                  <td className="px-5 py-3"><input className={`${inputClass} w-20`} value={topic[1]} onChange={(event) => updateTopic(index, 1, event.target.value)} /></td>
                  <td className="px-5 py-3"><input className={inputClass} value={topic[2]} onChange={(event) => updateTopic(index, 2, event.target.value)} /></td>
                  <td className="px-5 py-3"><select className={inputClass} value={topic[3]} onChange={(event) => updateTopic(index, 3, event.target.value)}><option>关闭话题</option><option>频道禁言</option><option>交流频道</option></select></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </ConsoleShell>
  );
}
