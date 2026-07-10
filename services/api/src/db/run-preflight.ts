import { runPreflight } from "../ops/preflight.js";

/**
 * M13 operator command: production preflight.
 *
 *   pnpm --filter @nova/api ops:preflight
 *
 * Runs against the CURRENT environment (set NODE_ENV=production plus the
 * real secrets to validate a production config before deploying). Exits 0
 * when every check passes, 1 when anything fails. Warnings don't fail the
 * run — they are the operator's judgement calls, printed loudly.
 */
const ICONS = { ok: "✓", warn: "!", fail: "✗" } as const;

runPreflight()
  .then((report) => {
    console.log(
      `nova preflight — mode=${report.production ? "production" : "development"}`,
    );
    for (const c of report.checks) {
      console.log(`  ${ICONS[c.status]} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    console.log(report.ok ? "PREFLIGHT OK" : "PREFLIGHT FAILED");
    process.exit(report.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("preflight crashed:", (err as Error).message);
    process.exit(1);
  });
