"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "登录失败，请稍后重试");
      router.replace("/group-config");
      router.refresh();
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f8f6] px-5 py-12">
      <section className="w-full max-w-md rounded-2xl border border-ops-line bg-white p-7 shadow-[0_22px_70px_rgba(16,24,21,0.10)] md:p-9">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-ops-accent text-xl font-black text-white">Y</span>
          <div>
            <h1 className="text-2xl font-black tracking-tight">YUBIT 后台</h1>
            <p className="mt-1 text-sm text-ops-muted">登录后管理内容发布与群运营</p>
          </div>
        </div>
        <form className="grid gap-5" onSubmit={submit}>
          <label className="grid gap-2 text-sm font-bold text-[#33423b]">
            账号
            <input
              autoComplete="username"
              autoFocus
              className="min-h-12 rounded-lg border border-ops-line bg-white px-4 outline-none transition focus:border-ops-accent focus:ring-2 focus:ring-[#d8eee4]"
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
          </label>
          <label className="grid gap-2 text-sm font-bold text-[#33423b]">
            密码
            <input
              autoComplete="current-password"
              className="min-h-12 rounded-lg border border-ops-line bg-white px-4 outline-none transition focus:border-ops-accent focus:ring-2 focus:ring-[#d8eee4]"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700" role="alert">{error}</p> : null}
          <button
            className="min-h-12 rounded-lg bg-ops-accent px-5 font-black text-white transition hover:brightness-95 disabled:cursor-wait disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "正在登录…" : "登录后台"}
          </button>
        </form>
        <p className="mt-6 text-center text-xs leading-5 text-ops-muted">会话会在 12 小时后自动失效，请勿在公共电脑保存密码。</p>
      </section>
    </main>
  );
}
