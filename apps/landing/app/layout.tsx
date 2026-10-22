import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "../components/iso/iso.css";
import "./globals.css";

const geist = localFont({
  src: "../fonts/geist-latin.woff2",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "../fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nova Context",
  description: "La capa bajo los asistentes. Capturas lo que ves, dices qué significa y confirmas antes de que nada se guarde o salga.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-black font-sans antialiased">{children}</body>
    </html>
  );
}
