import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nova Context",
  description: "Human context infrastructure.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await headers()).get("x-nova-locale") === "es" ? "es" : "en";
  return (
    <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
