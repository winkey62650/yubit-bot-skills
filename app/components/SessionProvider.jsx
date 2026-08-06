"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const SessionContext = createContext({ loading: true, user: null });

export function SessionProvider({ children }) {
  const pathname = usePathname();
  const [state, setState] = useState({ loading: pathname !== "/login", user: null });

  useEffect(() => {
    if (pathname === "/login") {
      setState({ loading: false, user: null });
      return;
    }
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("session unavailable")))
      .then((data) => { if (active) setState({ loading: false, user: data.user || null }); })
      .catch(() => { if (active) setState({ loading: false, user: null }); });
    return () => { active = false; };
  }, [pathname]);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession() { return useContext(SessionContext); }
