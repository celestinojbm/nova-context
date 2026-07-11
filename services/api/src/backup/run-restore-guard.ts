import { classifyRestoreTarget } from "./target.js";

/**
 * M15B (Hermes D03): restore-target guard, called by scripts/restore.sh.
 * Reads DATABASE_URL + NODE_ENV from the environment and prints ONLY a
 * redacted target line (never credentials). Exit code communicates the
 * verdict to the shell:
 *   0 → local scratch target (typed confirmation is enough)
 *   3 → requires the production override (NOVA_RESTORE_ALLOW_PRODUCTION=yes)
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const t = classifyRestoreTarget(url, process.env.NODE_ENV);
console.log(`target: ${t.redacted}`);
process.exit(t.requiresOverride ? 3 : 0);
