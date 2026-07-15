import "./globals.css";

export const metadata = {
  title: "YUBIT Ops Console",
  description: "Telegram community operations console for YUBIT bot skills.",
  robots: {
    index: false,
    follow: false,
    nocache: true
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
