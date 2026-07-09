import pg from "pg";
import { loadEnv } from "../env.js";
import { hashPassword } from "../auth/passwords.js";

/**
 * Operator password reset (M7). There is no self-service reset in the
 * private alpha; an operator with database + shell access runs:
 *
 *   NOVA_RESET_EMAIL=user@example.com NOVA_RESET_PASSWORD='new-password-here' \
 *     pnpm --filter @nova/api auth:reset-password
 *
 * Sets the new hash and revokes EVERY session for that account (the user
 * signs in fresh everywhere). Works in production by design — it is the
 * documented recovery path. The new password never appears in logs or audit.
 */
const email = process.env.NOVA_RESET_EMAIL?.trim().toLowerCase();
const password = process.env.NOVA_RESET_PASSWORD;
if (!email || !password) {
  console.error("Set NOVA_RESET_EMAIL and NOVA_RESET_PASSWORD.");
  process.exit(1);
}
if (password.length < 10) {
  console.error("NOVA_RESET_PASSWORD must be at least 10 characters.");
  process.exit(1);
}

const env = loadEnv();
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  const hash = await hashPassword(password);
  const user = await client.query<{ id: string }>(
    `UPDATE users SET password_hash = $1 WHERE email = $2 AND deleted_at IS NULL RETURNING id`,
    [hash, email],
  );
  if (!user.rowCount) {
    console.error(`No account found for ${email}.`);
    process.exit(1);
  }
  const userId = user.rows[0]!.id;
  const revoked = await client.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  await client.query(
    `INSERT INTO audit_log (user_id, event_type, detail) VALUES ($1, 'auth.password.reset', $2)`,
    [userId, JSON.stringify({ by: "operator", revoked_sessions: revoked.rowCount ?? 0 })],
  );
  console.log(`Password reset for ${email}; ${revoked.rowCount ?? 0} session(s) revoked.`);
} finally {
  await client.end();
}
