import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nova Context — Timeline",
  description: "Your captured context moments.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <strong>Nova Context</strong>
          <span className="muted">memory timeline</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
