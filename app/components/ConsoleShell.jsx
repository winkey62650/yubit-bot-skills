"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/group-config", label: "群配置" },
  { href: "/new-group", label: "新群初始化" },
  { href: "/news", label: "新闻配置" },
  { href: "/signals", label: "信号配置" },
  { href: "/forward-broadcast", label: "广播转发" },
  { href: "/forward-social", label: "代理社媒转发" },
  { href: "/bots", label: "机器人配置" },
  { href: "/groups", label: "群数据" },
  { href: "/settings", label: "系统设置" }
];

export default function ConsoleShell({ children }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-[#fbfcfb] text-ops-ink lg:grid lg:grid-cols-[258px_minmax(0,1fr)]">
      <aside className="border-b border-ops-line bg-white p-6 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <Link className="mb-10 flex items-center gap-3" href="/">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-ops-accent text-lg font-black text-white">Y</span>
          <strong className="text-2xl tracking-tight">YUBIT</strong>
        </Link>
        <nav className="grid gap-2">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                className={`flex min-h-12 items-center rounded-lg px-3 text-left text-sm font-bold transition ${active ? "bg-[#edf7f2] text-ops-accent shadow-sm" : "text-[#33423b] hover:bg-ops-soft"}`}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-12 rounded-lg border border-ops-line bg-white p-4 shadow-sm">
          <div className="text-sm font-black">帮助与支持</div>
          <p className="mt-1 text-xs leading-5 text-ops-muted">使用文档 / 常见问题</p>
        </div>
      </aside>
      <main className="p-5 md:p-8">{children}</main>
    </div>
  );
}
