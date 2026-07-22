import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Site Nerve · 代理站点运营中台",
  description: "代理网站统一收录、流量与转化数据分析中台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
