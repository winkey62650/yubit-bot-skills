"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_LOCALE, localizeUiError, localizeUiText, normalizeLocale, translate } from "../../lib/i18n.mjs";

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);
  const textOriginalsRef = useRef(new WeakMap());

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
  useEffect(() => {
    const originals = textOriginalsRef.current;
    const attributeNames = ["placeholder", "title", "aria-label"];
    let applying = false;

    function translateTree(root) {
      if (!root || applying) return;
      applying = true;
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
          if (node.parentElement?.closest("[data-i18n-skip], script, style")) continue;
          if (locale === "en") {
            if (/[\p{Script=Han}]/u.test(node.data)) originals.set(node, node.data);
            const translated = localizeUiText(locale, originals.get(node) || node.data);
            if (translated !== node.data) node.data = translated;
          } else if (originals.has(node)) {
            node.data = originals.get(node);
            originals.delete(node);
          }
        }
        const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll("*")] : [];
        for (const element of elements) {
          if (element.closest("[data-i18n-skip]")) continue;
          for (const attribute of attributeNames) {
            const marker = `data-i18n-original-${attribute}`;
            if (locale === "en" && element.hasAttribute(attribute)) {
              const current = element.getAttribute(attribute) || "";
              if (/[\p{Script=Han}]/u.test(current) && !element.hasAttribute(marker)) element.setAttribute(marker, current);
              if (element.hasAttribute(marker)) element.setAttribute(attribute, localizeUiText(locale, element.getAttribute(marker)));
            } else if (locale !== "en" && element.hasAttribute(marker)) {
              element.setAttribute(attribute, element.getAttribute(marker));
              element.removeAttribute(marker);
            }
          }
        }
      } finally {
        applying = false;
      }
    }

    translateTree(document.body);
    const observer = new MutationObserver((mutations) => {
      if (applying) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") translateTree(mutation.target);
        for (const node of mutation.addedNodes) translateTree(node);
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale,
    t: (key, values) => translate(locale, key, values),
    l: (zh, en) => normalizeLocale(locale) === "en" ? en : zh,
    localizeError: (message, fallback) => localizeUiError(locale, message, fallback)
  }), [locale]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext) || {
    locale: DEFAULT_LOCALE,
    setLocale: () => {},
    t: (key, values) => translate(DEFAULT_LOCALE, key, values),
    l: (zh) => zh,
    localizeError: (message, fallback) => localizeUiError(DEFAULT_LOCALE, message, fallback)
  };
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
