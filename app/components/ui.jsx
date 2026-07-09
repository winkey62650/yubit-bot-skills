export const inputClass = "min-h-10 rounded-lg border border-ops-line bg-white px-3 text-sm outline-none focus:border-ops-accent focus:ring-4 focus:ring-ops-accent/10";

export function PageHeader({ title, desc, action }) {
  return (
    <header className="mb-7 flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
      <div>
        <h1 className="text-3xl font-black tracking-tight">{title}</h1>
        <p className="mt-3 max-w-3xl text-base leading-7 text-ops-muted">{desc}</p>
      </div>
      {action}
    </header>
  );
}

export function Metric({ icon, label, value, sub }) {
  return (
    <div className="flex items-center gap-4 border-b border-ops-line p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-[#edf7f2] text-sm font-black text-ops-accent">{icon}</span>
      <div>
        <div className="text-sm font-bold text-ops-muted">{label}</div>
        <div className="mt-1 text-2xl font-black">{value}</div>
        <div className="mt-1 text-xs text-ops-muted">{sub}</div>
      </div>
    </div>
  );
}

export function Field({ label, children }) {
  return <label className="grid gap-1.5 text-sm font-bold text-ops-muted">{label}{children}</label>;
}

export function StatusPill({ children, tone = "green" }) {
  const styles = tone === "amber" ? "bg-[#fff4df] text-[#c98118]" : "bg-[#e6f7ef] text-ops-accent";
  return <span className={`rounded-full px-2 py-1 text-xs font-black ${styles}`}>{children}</span>;
}

export function Card({ children, className = "" }) {
  return <section className={`rounded-lg border border-ops-line bg-white shadow-ops ${className}`}>{children}</section>;
}
