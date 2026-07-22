import { classifyScratchTarget, dbTargetFingerprint } from "./target.js";

/**
 * M18A.2: scratch-target guard for the automated recovery GATE (distinct from
 * `backup:restore-guard`, which serves `scripts/restore.sh`'s local/production
 * decision). Reads DATABASE_URL + the NOVA_RESTORE_* authorization envelope and
 * prints ONLY a credential-free redacted target plus names-only reasons — never
 * a DSN, username, password, or fingerprint value.
 *
 *   backup:scratch-guard                 → classify DATABASE_URL
 *   backup:scratch-guard -- --fingerprint → print the canonical DB fingerprint
 *                                           of DATABASE_URL (safe: no creds) so
 *                                           an operator can populate
 *                                           NOVA_RESTORE_EXPECT_FINGERPRINT /
 *                                           NOVA_PRIMARY_DATABASE_FINGERPRINT.
 *
 * Exit codes (consumed by the gate's scratchTargetGuard):
 *   0 → safe scratch target (local loopback non-prod, OR authorized remote)
 *   3 → BLOCKED (remote unauthorized / mismatch / primary-equal / malformed
 *       expectation / production)
 *   2 → error (DATABASE_URL missing or malformed)
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

if (process.argv.includes("--fingerprint")) {
  try {
    console.log(dbTargetFingerprint(url));
    process.exit(0);
  } catch {
    console.error("DATABASE_URL is malformed/unparseable");
    process.exit(2);
  }
}

const c = classifyScratchTarget(url, process.env);
console.log(`scratch target: ${c.redacted} [${c.verdict}]`);
for (const r of c.reasons) console.log(`  - ${r}`);

switch (c.verdict) {
  case "local_scratch":
  case "remote_scratch":
    process.exit(0);
  case "blocked":
    process.exit(3);
  default:
    process.exit(2);
}
