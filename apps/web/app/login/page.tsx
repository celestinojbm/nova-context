import { loginAction, signupAction } from "../lib/auth-actions";

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
  searchParams: Promise<{ error?: string; next?: string; mode?: string; deleted?: string }>;
}) {
  const { error, next, mode, deleted } = await searchParams;
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
      {message && <div className="error-banner">{message}</div>}

      {!signup ? (
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
