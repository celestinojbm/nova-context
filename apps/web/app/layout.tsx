import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { MeResponse } from "@nova/schema";
import { API_URL, sessionToken } from "./lib/api";
import { logoutAction } from "./lib/auth-actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nova Context — Timeline",
  description: "Your captured context moments.",
};

/** Best-effort: header user chip only. Never redirects (the layout also
 * wraps /login); pages handle expired sessions themselves. */
async function currentUser(): Promise<MeResponse["user"] | null> {
  const token = await sessionToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_URL}/v1/auth/me`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as MeResponse).user;
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <strong>Nova Context</strong>
          {user ? (
            <>
              <nav className="site-nav">
                <a href="/">Timeline</a>
                <a href="/tasks">Tasks</a>
                <a href="/projects">Projects</a>
                <a href="/approvals">Approvals</a>
                <a href="/audit">Audit</a>
                <a href="/settings">Settings</a>
              </nav>
              <div className="session-chip">
                <span className="muted">{user.display_name ?? user.email}</span>
                <form action={logoutAction}>
                  <button type="submit">Sign out</button>
                </form>
              </div>
            </>
          ) : (
            <span className="muted">private alpha</span>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
