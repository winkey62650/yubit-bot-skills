"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

const navItems = [
  { href: "/distribution?view=site-analytics", label: "网站数据", view: "site-analytics" },
  { href: "/distribution?view=automation", label: "内容分发中心", view: "automation" },
  { href: "/group-config", label: "群与 Topic" },
  { href: "/new-group", label: "新群初始化" },
  { href: "/discord", label: "Discord 社区" },
  { href: "/trading", label: "交易中心" },
  { href: "/telegram-user-authorization", label: "发布账号状态检测" },
  { href: "/bots", label: "后台能力" },
  { href: "/settings", label: "系统设置" }
];

function NavigationLinks({ pathname, distributionView }) {
  return (
    <nav className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:mt-0 lg:grid lg:overflow-visible lg:pb-0">
      {navItems.map((item) => {
        const active = item.view
          ? pathname === "/distribution" && distributionView === item.view
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            className={`flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-left text-sm font-bold transition lg:min-h-12 ${active ? "bg-[#edf7f2] text-ops-accent shadow-sm" : "text-[#33423b] hover:bg-ops-soft"}`}
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ConsoleNavigation({ pathname }) {
  const searchParams = useSearchParams();
  const distributionView = searchParams.get("view") || "automation";
  return <NavigationLinks distributionView={distributionView} pathname={pathname} />;
}

export default function ConsoleShell({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }
  return (
    <div className="min-h-screen max-w-full overflow-x-hidden bg-[#fbfcfb] text-ops-ink lg:grid lg:grid-cols-[238px_minmax(0,1fr)] xl:grid-cols-[258px_minmax(0,1fr)]">
      <aside className="min-w-0 max-w-full border-b border-ops-line bg-white px-4 py-3 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-6">
        <div className="flex items-center justify-between gap-3 lg:block">
        <Link className="flex min-w-0 shrink items-center gap-3 lg:mb-10" href="/">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-ops-accent text-lg font-black text-white">Y</span>
          <strong className="text-xl tracking-tight lg:text-2xl">YUBIT</strong>
        </Link>
        <button
          className="min-h-10 rounded-lg border border-ops-line bg-white px-3 text-xs font-bold text-[#33423b] lg:hidden"
          disabled={loggingOut}
          onClick={logout}
          type="button"
        >
          {loggingOut ? "退出中…" : "退出"}
        </button>
        </div>
        <Suspense fallback={<NavigationLinks distributionView="automation" pathname={pathname} />}>
          <ConsoleNavigation pathname={pathname} />
        </Suspense>
        <div className="mt-12 hidden rounded-lg border border-ops-line bg-white p-4 shadow-sm lg:block">
          <div className="text-sm font-black">帮助与支持</div>
          <p className="mt-1 text-xs leading-5 text-ops-muted">使用文档 / 常见问题</p>
        </div>
        <button
          className="mt-4 hidden min-h-11 w-full rounded-lg border border-ops-line bg-white px-4 text-sm font-bold text-[#33423b] transition hover:bg-ops-soft disabled:cursor-wait disabled:opacity-60 lg:block"
          disabled={loggingOut}
          onClick={logout}
          type="button"
        >
          {loggingOut ? "正在退出…" : "退出登录"}
        </button>
      </aside>
      <main className="min-w-0 max-w-full overflow-x-hidden p-4 sm:p-5 md:p-7 xl:p-8">{children}</main>
    </div>
  );
}
