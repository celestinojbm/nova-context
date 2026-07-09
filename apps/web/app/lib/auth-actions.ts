"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { CreateSessionResponse } from "@nova/schema";
import { API_URL, SESSION_COOKIE, sessionToken } from "./api";

/**
 * Auth server actions (M5). Next.js server actions carry built-in Origin
 * checking, and the session cookie is HttpOnly + SameSite=Lax + Secure (in
 * production), so login/logout can't be driven cross-site.
 */

async function setSessionCookie(session: CreateSessionResponse): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expires_at),
  });
}

function safeNext(value: FormDataEntryValue | null): string {
  // Only same-app absolute paths — never an external redirect target.
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = formData.get("email");
  const password = formData.get("password");
  const next = safeNext(formData.get("next"));
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    redirect("/login?error=missing");
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
  } catch {
    redirect("/login?error=unreachable");
  }
  if (res.status === 401) redirect(`/login?error=credentials&next=${encodeURIComponent(next)}`);
  if (res.status === 429) redirect("/login?error=rate");
  if (!res.ok) redirect("/login?error=server");
  await setSessionCookie((await res.json()) as CreateSessionResponse);
  redirect(next);
}

export async function signupAction(formData: FormData): Promise<void> {
  const email = formData.get("email");
  const password = formData.get("password");
  const displayName = formData.get("display_name");
  const inviteCode = formData.get("invite_code");
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    redirect("/login?error=missing&mode=signup");
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        display_name:
          typeof displayName === "string" && displayName.trim() ? displayName.trim() : undefined,
        invite_code:
          typeof inviteCode === "string" && inviteCode.trim() ? inviteCode.trim() : undefined,
      }),
      cache: "no-store",
    });
  } catch {
    redirect("/login?error=unreachable&mode=signup");
  }
  if (res.status === 409) redirect("/login?error=email_taken&mode=signup");
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    redirect(
      body?.error === "signup_closed"
        ? "/login?error=signup_closed&mode=signup"
        : "/login?error=invite&mode=signup",
    );
  }
  if (res.status === 429) redirect("/login?error=rate&mode=signup");
  if (!res.ok) redirect("/login?error=invalid_signup&mode=signup");
  await setSessionCookie((await res.json()) as CreateSessionResponse);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const token = await sessionToken();
  if (token) {
    // Revoke server-side; even if the API is briefly unreachable we still
    // drop the cookie so the browser is signed out.
    await fetch(`${API_URL}/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => undefined);
  }
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
