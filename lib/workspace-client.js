export async function loadWorkspaceState(section) {
  const response = await fetch(`/api/workspace-state?section=${encodeURIComponent(section)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "读取云端配置失败");
  return data;
}

export async function saveWorkspaceState(section, state) {
  const response = await fetch("/api/workspace-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ section, state })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "保存云端配置失败");
  return data;
}
