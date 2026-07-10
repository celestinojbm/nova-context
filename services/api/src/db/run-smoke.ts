import { runSmoke } from "../ops/smoke.js";

/**
 * M13 operator command: post-deploy smoke suite.
 *
 *   pnpm --filter @nova/api ops:smoke -- --base-url=https://api.example.com
 *   pnpm --filter @nova/api ops:smoke -- --base-url=... --invite=<code>
 *
 * Creates a synthetic account (invite code required if signup is
 * invite-only), walks every product surface with synthetic content, then
 * deletes the account through the real deletion flow. Exits 0 when nothing
 * failed (degraded steps are reported but don't fail — they reflect what
 * the deploy has intentionally disabled). One manual step remains AFTER
 * this passes: `ops:maintenance` (dry run) from the operator machine.
 */
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const baseUrl = arg("base-url") ?? process.env.NOVA_SMOKE_BASE_URL ?? "http://localhost:3001";
const inviteCode = arg("invite") ?? process.env.NOVA_SMOKE_INVITE;

const ICONS = { ok: "✓", degraded: "~", fail: "✗" } as const;

runSmoke(baseUrl, { inviteCode })
  .then(({ ok, steps }) => {
    console.log(`nova smoke — ${baseUrl}`);
    for (const s of steps) {
      console.log(`  ${ICONS[s.status]} ${s.step}${s.detail ? ` — ${s.detail}` : ""}`);
    }
    console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
    if (ok) console.log("reminder: run `ops:maintenance` (dry run) to finish the post-deploy checklist");
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("smoke crashed:", (err as Error).message);
    process.exit(1);
  });
