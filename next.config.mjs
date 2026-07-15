/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // /api/scripts launches these helpers as child processes. Next cannot infer
  // those dynamic paths, so explicitly ship them with the serverless function.
  outputFileTracingIncludes: {
    "/api/scripts": [
      "./scripts/**/*",
      "./lib/json-store.js",
      "./lib/telegram-setup-state.mjs",
      "./lib/telegram-topic-icons.mjs",
      "./*.mjs",
      "./telegram-community.config.json",
      "./node_modules/@vercel/**/*",
      "./node_modules/jose/**/*",
      "./node_modules/async-retry/**/*",
      "./node_modules/cross-spawn/**/*",
      "./node_modules/execa/**/*",
      "./node_modules/get-stream/**/*",
      "./node_modules/human-signals/**/*",
      "./node_modules/is-buffer/**/*",
      "./node_modules/is-node-process/**/*",
      "./node_modules/is-stream/**/*",
      "./node_modules/isexe/**/*",
      "./node_modules/merge-stream/**/*",
      "./node_modules/mimic-fn/**/*",
      "./node_modules/npm-run-path/**/*",
      "./node_modules/onetime/**/*",
      "./node_modules/os-paths/**/*",
      "./node_modules/path-key/**/*",
      "./node_modules/retry/**/*",
      "./node_modules/shebang-command/**/*",
      "./node_modules/shebang-regex/**/*",
      "./node_modules/signal-exit/**/*",
      "./node_modules/strip-final-newline/**/*",
      "./node_modules/throttleit/**/*",
      "./node_modules/undici/**/*",
      "./node_modules/which/**/*",
      "./node_modules/xdg-app-paths/**/*",
      "./node_modules/xdg-portable/**/*",
      "./node_modules/zod/**/*"
    ]
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
        ]
      }
    ];
  }
};

export default nextConfig;
