"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, normalizeLocale, translate } from "../../lib/i18n.mjs";

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);

  useEffect(() => {
    const saved = window.localStorage.getItem("yubit_locale") || document.cookie.match(/(?:^|; )yubit_locale=([^;]+)/)?.[1];
    setLocaleState(normalizeLocale(saved));
  }, []);

  function setLocale(nextLocale) {
    const normalized = normalizeLocale(nextLocale);
    setLocaleState(normalized);
    window.localStorage.setItem("yubit_locale", normalized);
    document.cookie = `yubit_locale=${normalized}; path=/; max-age=31536000; samesite=lax`;
  }

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t: (key, values) => translate(locale, key, values) }), [locale]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext) || { locale: DEFAULT_LOCALE, setLocale: () => {}, t: (key, values) => translate(DEFAULT_LOCALE, key, values) };
}

export function LanguageToggle({ className = "" }) {
  const { locale, setLocale } = useLanguage();
  const english = locale === "en";
  return (
    <button
      aria-label={english ? "切换为中文" : "Switch to English"}
      className={`min-h-10 rounded-lg border border-ops-line bg-white px-3 text-xs font-black text-[#33423b] transition hover:bg-ops-soft ${className}`}
      onClick={() => setLocale(english ? "zh-CN" : "en")}
      type="button"
    >
      {english ? "中文" : "EN"}
    </button>
  );
}
