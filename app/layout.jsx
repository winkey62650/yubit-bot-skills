import "./globals.css";
import { LanguageProvider } from "./components/LanguageProvider";
import { SessionProvider } from "./components/SessionProvider";

export const metadata = {
  title: "YUBIT Ops Console",
  description: "Telegram community operations console for YUBIT bot skills.",
  icons: {
    icon: "/favicon.svg"
  },
  robots: {
    index: false,
    follow: false,
    nocache: true
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body><LanguageProvider><SessionProvider>{children}</SessionProvider></LanguageProvider></body>
    </html>
  );
}
