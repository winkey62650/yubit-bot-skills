export default function SocialPostStatus({ source, status }) {
  if (source.postSyncMode !== 'verified') return null;
  const check = status?.lastCheck;
  const text = source.status !== '已启用' || !source.postMonitoring ? '普通更新已暂停'
    : check?.state === 'error' ? '普通更新检查失败' : check ? '普通更新监控运行中' : '等待首次普通更新检查';
  return <div className="mx-4 mt-4 rounded-md bg-[#f2faf6] p-3 text-xs" role="status">
    <strong>{source.name} · {text}</strong>
    <p className="mt-1">每 5 分钟检查 · 英文推送 · 逐条去重 · 首次启用不补发历史内容</p>
    {source.platform === 'YouTube' ? <p className="mt-1">普通视频与直播独立监控，直播回放不重复推送。</p> : null}
    {check?.warning ? <p className="mt-1 break-words text-[#a04a3d]">{check.warning}</p> : null}
    {check?.error ? <p className="mt-1 break-words text-[#a04a3d]">{check.error}</p> : null}
    {check?.checkedAt ? <p className="mt-1">最近检查：{new Date(check.checkedAt).toLocaleString()}</p> : null}
    {check?.notifications?.some(n => ['manual-reconciliation', 'dispatching'].includes(n.status)) ? <p className="mt-1 text-[#a04a3d]">存在需核对的投递，已停止自动重发。</p> : null}
  </div>;
}
