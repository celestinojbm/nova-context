import pg from "pg";
import { loadEnv } from "../env.js";
import { hashPassword } from "../auth/passwords.js";

/**
 * Local-dev convenience (M5): give the seeded dev@nova.local account a
 * password so all pre-auth M0–M4 data stays reachable through a normal
 * login. Refuses to run in production — real accounts sign up there.
 *
 *   pnpm --filter @nova/api db:seed-dev            # password: nova-dev-password
 *   NOVA_DEV_PASSWORD=... pnpm --filter @nova/api db:seed-dev
 */
const env = loadEnv();
if (env.isProduction) {
  console.error("db:seed-dev is for local development only (NODE_ENV=production set).");
  process.exit(1);
}
const password = process.env.NOVA_DEV_PASSWORD ?? "nova-dev-password";
if (password.length < 10) {
  console.error("NOVA_DEV_PASSWORD must be at least 10 characters.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  const hash = await hashPassword(password);
  const { rowCount } = await client.query(
    `UPDATE users SET password_hash = $1 WHERE email = 'dev@nova.local'`,
    [hash],
  );
  if (!rowCount) {
    console.error("dev@nova.local not found — run pnpm db:migrate first.");
    process.exit(1);
  }
  console.log(
    `dev@nova.local can now sign in${process.env.NOVA_DEV_PASSWORD ? "" : " with the default dev password (nova-dev-password)"}.`,
  );
} finally {
  await client.end();
}
