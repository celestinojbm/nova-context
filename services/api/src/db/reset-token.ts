import { randomBytes } from "node:crypto";
import pg from "pg";
import { sha256Hex } from "../auth/sessions.js";
import { loadEnv } from "../env.js";

/**
 * M11 operator-assisted password reset (alpha has no email sender):
 *
 *   pnpm --filter @nova/api auth:reset-token -- user@example.com
 *
 * Mints a single-use, 30-minute reset token for the account and prints the
 * reset URL ONCE to this terminal — hand it to the user out-of-band
 * (voice, existing chat). The database stores only the token's hash; the
 * URL printed here is the only copy in existence. Refuses to run in
 * production unless NOVA_OPERATOR_RESET=yes acknowledges the action.
 */
const email = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!email) {
  console.error("usage: auth:reset-token -- <email>");
  process.exit(1);
}
const env = loadEnv();
if (env.isProduction && process.env.NOVA_OPERATOR_RESET !== "yes") {
  console.error("Refusing in production without NOVA_OPERATOR_RESET=yes.");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
const { rows } = await pool.query<{ id: string }>(
  `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
  [email.toLowerCase()],
);
if (!rows.length) {
  console.error("No such account.");
  await pool.end();
  process.exit(1);
}
const token = `nova_reset_${randomBytes(32).toString("base64url")}`;
await pool.query(
  `INSERT INTO password_resets (user_id, token_hash, expires_at)
   VALUES ($1, $2, now() + interval '30 minutes')`,
  [rows[0]!.id, sha256Hex(token)],
);
await pool.query(
  `INSERT INTO audit_log (user_id, event_type, detail)
   VALUES ($1, 'auth.password.reset_requested', '{"via":"operator"}')`,
  [rows[0]!.id],
);
const webUrl = process.env.NOVA_WEB_URL ?? "http://localhost:3000";
console.log(`Reset link (single use, expires in 30 minutes — deliver out-of-band):`);
console.log(`  ${webUrl}/reset?token=${token}`);
await pool.end();
