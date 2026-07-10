import { redirect } from "next/navigation";
import { API_URL } from "../lib/api";

export const dynamic = "force-dynamic";

/**
 * M11 password reset landing. The single-use token arrives out-of-band
 * from the operator (alpha has no email sender). Confirming sets the new
 * password and revokes every existing session.
 */

async function confirmReset(formData: FormData) {
  "use server";
  const token = formData.get("token");
  const password = formData.get("new_password");
  if (typeof token !== "string" || typeof password !== "string") {
    redirect("/reset?error=missing");
  }
  const res = await fetch(`${API_URL}/v1/auth/password-reset/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, new_password: password }),
    cache: "no-store",
  });
  if (res.status === 429) redirect(`/reset?token=${encodeURIComponent(token)}&error=rate`);
  if (res.status === 400) redirect(`/reset?token=${encodeURIComponent(token)}&error=invalid`);
  if (!res.ok) redirect(`/reset?token=${encodeURIComponent(token)}&error=server`);
  redirect("/login?reset=1");
}

const ERRORS: Record<string, string> = {
  missing: "Token and a new password (10+ characters) are required.",
  invalid: "This reset link is invalid, expired, or already used. Ask the operator for a fresh one.",
  rate: "Too many attempts — wait a few minutes.",
  server: "The Nova API returned an error. Try again.",
};

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  const message = error ? (ERRORS[error] ?? "Something went wrong.") : null;
  return (
    <div className="auth-page">
      <h2>Reset your password</h2>
      <p className="muted">
        Use the single-use link the operator gave you. Resetting signs out
        every existing session and device.
      </p>
      {message && <div className="error-banner">{message}</div>}
      {!token ? (
        <p className="muted">
          This page needs a reset link. Ask the operator to run{" "}
          <code>auth:reset-token</code> and send you the URL, or request one
          from the <a href="/login">sign-in page</a>.
        </p>
      ) : (
        <form action={confirmReset} className="auth-form">
          <input type="hidden" name="token" value={token} />
          <label>
            New password (10+ characters)
            <input
              type="password"
              name="new_password"
              autoComplete="new-password"
              minLength={10}
              required
            />
          </label>
          <button type="submit">Set new password</button>
        </form>
      )}
    </div>
  );
}
