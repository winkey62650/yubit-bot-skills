/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ops: {
          bg: "#f6f8f7",
          surface: "#ffffff",
          soft: "#eef4f1",
          ink: "#101815",
          muted: "#65746d",
          line: "#dbe4df",
          accent: "#15956b",
          accentStrong: "#087a59",
          cyan: "#19a7c8",
          danger: "#d64b4b",
          warning: "#c98118"
        }
      },
      boxShadow: {
        ops: "0 16px 40px rgba(28, 49, 40, 0.08)"
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["SFMono-Regular", "Consolas", "Liberation Mono", "monospace"]
      }
    }
  },
  plugins: []
};
