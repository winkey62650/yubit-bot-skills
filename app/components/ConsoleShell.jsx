"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { filterNavigationForRole, ROLES } from "../../lib/access-control.mjs";
import { LanguageToggle, useLanguage } from "./LanguageProvider";
import { useSession } from "./SessionProvider";

const NAVIGATION_STORAGE_KEY = "yubit-console-navigation-sections";

const navSections = [
  {
    key: "telegram",
    collapsible: true,
    label: "nav.telegram",
    roles: [ROLES.ADMIN, ROLES.MANUAL_PUBLISHER],
    items: [
      { href: "/distribution?view=automation", label: "nav.distribution", view: "automation", roles: [ROLES.ADMIN] },
      { href: "/composer", label: "nav.composer", roles: [ROLES.ADMIN, ROLES.MANUAL_PUBLISHER] },
      { href: "/group-config", label: "nav.groups", roles: [ROLES.ADMIN] },
      { href: "/new-group", label: "nav.newGroup", roles: [ROLES.ADMIN] },
      { href: "/telegram-user-authorization", label: "nav.publisherStatus", roles: [ROLES.ADMIN, ROLES.MANUAL_PUBLISHER] },
      { href: "/bots", label: "nav.capabilities", roles: [ROLES.ADMIN] }
    ]
  },
  {
    key: "discord",
    collapsible: true,
    label: "nav.discord",
    roles: [ROLES.ADMIN],
    items: [{ href: "/discord", label: "nav.discordWorkspace", roles: [ROLES.ADMIN] }]
  },
  {
    key: "operations",
    label: "nav.operations",
    roles: [ROLES.ADMIN],
    items: [
      { href: "/distribution?view=site-analytics", label: "nav.analytics", view: "site-analytics", roles: [ROLES.ADMIN] },
      { href: "/trading", label: "nav.trading", roles: [ROLES.ADMIN] },
      { href: "/settings", label: "nav.settings", roles: [ROLES.ADMIN] }
    ]
  }
];

function NavigationLinks({ pathname, distributionView, role, t }) {
  const [expandedSections, setExpandedSections] = useState({ telegram: true, discord: true });

  useEffect(() => {
    try {
      const savedSections = JSON.parse(window.localStorage.getItem(NAVIGATION_STORAGE_KEY) || "{}");
      setExpandedSections((current) => ({
        telegram: typeof savedSections.telegram === "boolean" ? savedSections.telegram : current.telegram,
        discord: typeof savedSections.discord === "boolean" ? savedSections.discord : current.discord
      }));
    } catch {
      // Invalid or unavailable local preferences should not block navigation.
    }
  }, []);

  function toggleNavigationSection(sectionKey) {
    setExpandedSections((current) => {
      const next = { ...current, [sectionKey]: !current[sectionKey] };
      try {
        window.localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Navigation remains usable when storage is unavailable.
      }
      return next;
    });
  }

  return (
    <nav className="mt-3 flex items-start gap-4 overflow-x-auto pb-1 lg:mt-0 lg:grid lg:gap-5 lg:overflow-visible lg:pb-0">
      {filterNavigationForRole(navSections, role).map((section) => {
        const expanded = !section.collapsible || expandedSections[section.key] !== false;
        const panelId = `console-navigation-${section.key}`;
        return (
          <section className="shrink-0 lg:min-w-0" key={section.key}>
            {section.collapsible ? (
              <button
                aria-controls={panelId}
                aria-expanded={expanded}
                className="flex min-h-8 w-full items-center justify-between gap-3 rounded-md px-3 pb-1 text-left text-[11px] font-black uppercase tracking-[0.12em] text-ops-muted transition hover:bg-ops-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ops-accent"
                onClick={() => toggleNavigationSection(section.key)}
                type="button"
              >
                <span>{t(section.label)}</span>
                <span
                  aria-hidden="true"
                  className={`text-sm leading-none transition-transform ${expanded ? "rotate-180" : ""}`}
                >
                  ▾
                </span>
              </button>
            ) : (
              <div className="px-3 pb-1 text-[11px] font-black uppercase tracking-[0.12em] text-ops-muted">
                {t(section.label)}
              </div>
            )}
            <div
              className={`gap-2 lg:gap-1 ${
                section.collapsible && !expanded ? "hidden" : "flex lg:grid"
              }`}
              id={panelId}
            >
              {section.items.map((item) => {
                const active = item.view
                  ? pathname === "/distribution" && distributionView === item.view
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    className={`flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-left text-sm font-bold transition lg:min-h-12 ${active ? "bg-[#edf7f2] text-ops-accent shadow-sm" : "text-[#33423b] hover:bg-ops-soft"}`}
                    href={item.href}
                    key={item.href}
                  >
                    {t(item.label)}
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </nav>
  );
}

function ConsoleNavigation({ pathname, role, t }) {
  const searchParams = useSearchParams();
  const distributionView = searchParams.get("view") || "automation";
  return <NavigationLinks distributionView={distributionView} pathname={pathname} role={role} t={t} />;
}

export default function ConsoleShell({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useLanguage();
  const { user } = useSession();
  const role = user?.role || ROLES.MANUAL_PUBLISHER;
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
        <div className="flex items-center gap-2 lg:hidden">
        <LanguageToggle />
        <button
          className="min-h-10 rounded-lg border border-ops-line bg-white px-3 text-xs font-bold text-[#33423b] lg:hidden"
          disabled={loggingOut}
          onClick={logout}
          type="button"
        >
          {loggingOut ? t("common.loggingOut") : t("common.logout")}
        </button>
        </div>
        </div>
        {role === ROLES.MANUAL_PUBLISHER ? <div className="mt-3 rounded-lg bg-ops-soft px-3 py-2 text-xs font-black text-ops-accent lg:mt-[-1.5rem] lg:mb-6">{t("role.manual")}</div> : null}
        <Suspense fallback={<NavigationLinks distributionView="automation" pathname={pathname} role={role} t={t} />}>
          <ConsoleNavigation pathname={pathname} role={role} t={t} />
        </Suspense>
        <div className="mt-12 hidden rounded-lg border border-ops-line bg-white p-4 shadow-sm lg:block">
          <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-black">{t("help.title")}</div>
          <p className="mt-1 text-xs leading-5 text-ops-muted">{t("help.desc")}</p></div><LanguageToggle /></div>
        </div>
        <button
          className="mt-4 hidden min-h-11 w-full rounded-lg border border-ops-line bg-white px-4 text-sm font-bold text-[#33423b] transition hover:bg-ops-soft disabled:cursor-wait disabled:opacity-60 lg:block"
          disabled={loggingOut}
          onClick={logout}
          type="button"
        >
          {loggingOut ? t("common.loggingOut") : t("common.logout")}
        </button>
      </aside>
      <main className="min-w-0 max-w-full overflow-x-hidden p-4 sm:p-5 md:p-7 xl:p-8">{children}</main>
    </div>
  );
}
