import { redirect } from "next/navigation";
import { API_URL } from "../lib/api";
import { loginAction, signupAction } from "../lib/auth-actions";

async function requestReset(formData: FormData) {
  "use server";
  const email = formData.get("email");
  if (typeof email !== "string" || !email) redirect("/login?error=missing");
  await fetch(`${API_URL}/v1/auth/password-reset/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
    cache: "no-store",
  }).catch(() => undefined);
  // Same outcome whether or not the account exists.
  redirect("/login?requested=1");
}

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  credentials: "Wrong email or password.",
  expired: "Your session expired or was revoked — sign in again.",
  missing: "Email and password are required.",
  rate: "Too many attempts. Wait a few minutes and try again.",
  server: "The Nova API returned an error. Try again.",
  unreachable: "Could not reach the Nova API. Is services/api running?",
  email_taken: "An account with that email already exists — sign in instead.",
  invite: "That invite code is not valid. Nova is in private alpha; ask for a current code.",
  signup_closed: "Sign-ups are closed right now. Nova is in private alpha.",
  invalid_signup: "Could not create the account — use a valid email and a password of at least 10 characters.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; mode?: string; deleted?: string; reset?: string; requested?: string }>;
}) {
  const { error, next, mode, deleted, reset, requested } = await searchParams;
  const message = error ? (ERROR_MESSAGES[error] ?? "Something went wrong.") : null;
  const signup = mode === "signup";
  const accountDeleted = deleted === "1";

  return (
    <div className="auth-page">
      <h2>{signup ? "Create your Nova account" : "Sign in to Nova"}</h2>
      <p className="muted">
        Nova Context is in <strong>private alpha</strong>. Your captured
        context is private to your account: sessions expire, and you can
        revoke any device from Settings.
      </p>

      {accountDeleted && (
        <div className="success">
          Your account and all its data were permanently deleted.
        </div>
      )}
      {reset === "1" && (
        <div className="success">
          Password reset. Sign in with your new password — all previous
          sessions were signed out.
        </div>
      )}
      {requested === "1" && (
        <div className="success">
          If that account exists, a reset was recorded. The operator will
          deliver your reset link out-of-band (private alpha has no email).
        </div>
      )}
      {message && <div className="error-banner">{message}</div>}

      {!signup ? (
        <>
        <form action={loginAction} className="auth-form">
          <input type="hidden" name="next" value={next ?? "/"} />
          <label>
            Email
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
          <button type="submit" className="primary">Sign in</button>
        </form>
        <details className="account-tools">
          <summary>Forgot your password?</summary>
          <form action={requestReset} className="auth-form">
            <label>
              Account email
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <button type="submit">Request reset</button>
            <p className="muted">
              The operator delivers the single-use reset link out-of-band
              (private alpha has no email sending).
            </p>
          </form>
        </details>
        </>
      ) : (
        <form action={signupAction} className="auth-form">
          <label>
            Email
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <label>
            Display name (optional)
            <input type="text" name="display_name" autoComplete="name" />
          </label>
          <label>
            Password (10+ characters)
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={10}
              required
            />
          </label>
          <label>
            Invite code (required while sign-ups are invite-only)
            <input type="text" name="invite_code" />
          </label>
          <button type="submit" className="primary">Create account</button>
        </form>
      )}

      <p className="muted">
        {signup ? (
          <a href="/login">Already have an account? Sign in</a>
        ) : (
          <a href="/login?mode=signup">Need an account? Sign up</a>
        )}
      </p>
    </div>
  );
}
