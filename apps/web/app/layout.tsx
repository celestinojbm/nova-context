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
          <nav className="site-nav">
            <a href="/">Timeline</a>
            <a href="/tasks">Tasks</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
