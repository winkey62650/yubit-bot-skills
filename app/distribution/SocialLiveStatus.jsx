export default function SocialLiveStatus({ source, status }) {
  if (!source.liveMonitoring) return null;
  const check = status?.lastCheck;
  const text = source.status !== '已启用' ? '直播监控已暂停'
    : !status ? '直播监控状态尚未读取'
    : !status.ready ? '直播接口未就绪，需要管理员配置平台凭据'
    : check?.state === 'error' ? '直播检查失败'
    : check?.state === 'live' ? '检测到正在直播'
    : check?.state === 'offline' ? '当前未开播'
    : '等待首次直播检查';
  return <div className="mx-4 mt-4 rounded-md bg-[#f2faf6] p-3 text-xs" role="status">
    <strong>{source.name} · {text}</strong>
    <p className="mt-1">每 5 分钟检查 · 沿用帖子推送目标</p>
    {check?.error ? <p className="mt-1 break-words text-[#a04a3d]">{check.error}</p> : null}
    {check?.checkedAt ? <p className="mt-1">最近检查：{new Date(check.checkedAt).toLocaleString()}</p> : null}
    {check?.notifications?.some(n => ['manual-reconciliation', 'dispatching', 'failed'].includes(n.status)) ? <p className="mt-1 text-[#a04a3d]">存在需核对的投递，已停止自动重发。</p> : null}
    {check?.notifications?.some(n => n.status === 'queued') ? <p className="mt-1">等待桌面发布；10 分钟后仍未投递则过期。</p> : null}
  </div>;
}
