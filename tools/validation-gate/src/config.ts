import {
  prLocalStack,
  predeployConfigSafety,
  predeployFeaturePosture,
  predeployPrerequisites,
} from "./checks/prerequisites.js";
import { opsStatusAuthed, postdeployPrerequisites, readyz } from "./checks/postdeploy.js";
import { recoveryPrerequisites, scratchTargetGuard, wrongBackupKey } from "./checks/recovery.js";
import type { CheckSpec, Mode, RunContext } from "./types.js";

/**
 * Validation Gate v0 configuration (M17B §10): which existing commands run,
 * in what order, with what severity/required/timeout. No secrets live here.
 *
 * Timeouts: per-check defaults below; override any check with
 *   NOVA_VALIDATE_TIMEOUT_<CHECK_ID_UPPERCASED>=<ms>
 * Output dir: artifacts/validation (override: NOVA_VALIDATE_OUT_DIR).
 */

const MIN = 60_000;

export function timeoutFor(spec: CheckSpec, env: NodeJS.ProcessEnv): number {
  const override = env[`NOVA_VALIDATE_TIMEOUT_${spec.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  const n = override ? Number(override) : NaN;
  return Number.isFinite(n) && n > 0 ? n : spec.timeoutMs;
}

/** PR gate: the established sequence, orchestrated — never duplicated.
 * Works with only the local/CI Postgres + Redis; no cloud credentials. */
function prChecks(): CheckSpec[] {
  return [
    {
      id: "pr_prerequisites",
      name: "Local validation stack (Postgres + Redis env)",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 10_000,
      fn: prLocalStack,
    },
    {
      id: "build",
      name: "Monorepo build (turbo run build)",
      category: "build",
      severity: "P0",
      required: true,
      timeoutMs: 20 * MIN,
      command: { cmd: "pnpm", args: ["build"] },
    },
    {
      id: "typecheck",
      name: "Monorepo typecheck (turbo run typecheck)",
      category: "typecheck",
      severity: "P0",
      required: true,
      timeoutMs: 15 * MIN,
      command: { cmd: "pnpm", args: ["typecheck"] },
    },
    {
      id: "unit",
      name: "Unit tests — schema, context-engine, model-router, extension, browser-shell, api, worker",
      category: "unit",
      severity: "P0",
      required: true,
      timeoutMs: 20 * MIN,
      command: { cmd: "pnpm", args: ["test"] },
    },
    {
      id: "migrate",
      name: "Database migrations (forward-only, tracked)",
      category: "integration",
      severity: "P0",
      required: true,
      timeoutMs: 10 * MIN,
      command: { cmd: "pnpm", args: ["db:migrate"] },
    },
    {
      id: "integration",
      name: "Integration tests — API + worker (auth, isolation, security/prompt-injection, visual-redaction, media, export/delete, backup/restore guards)",
      category: "integration",
      severity: "P0",
      required: true,
      timeoutMs: 40 * MIN,
      command: { cmd: "pnpm", args: ["test:integration"] },
    },
  ];
}

/** Pre-deploy gate: production posture + operator prerequisites +
 * ops:preflight. Missing infra → BLOCKED; unsafe supplied config → FAIL. */
function predeployChecks(): CheckSpec[] {
  return [
    {
      id: "predeploy_prerequisites",
      name: "Operator prerequisites present (names checked, values never printed)",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 10_000,
      fn: predeployPrerequisites,
    },
    {
      id: "config_safety",
      name: "Production configuration safety (invite-only, redaction on, no unsafe override, keys distinct)",
      category: "security",
      severity: "P0",
      required: true,
      timeoutMs: 10_000,
      fn: predeployConfigSafety,
    },
    {
      id: "feature_posture",
      name: "First-deploy feature posture (Notion/cloud/live-QA/transcription OFF)",
      category: "operations",
      severity: "P3",
      required: false,
      timeoutMs: 10_000,
      fn: predeployFeaturePosture,
    },
    {
      id: "preflight",
      name: "ops:preflight against the configured infrastructure",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 10 * MIN,
      command: { cmd: "pnpm", args: ["--filter", "@nova/api", "ops:preflight"] },
    },
  ];
}

/** Post-deploy gate: /readyz + authed status + synthetic ops:smoke (which
 * itself walks capture → OCR/redaction → media → worker → search → task →
 * export → delete with a self-deleting synthetic account). */
function postdeployChecks(ctx: RunContext): CheckSpec[] {
  const base = ctx.flags["base-url"] ?? "";
  const invite = ctx.flags.invite ?? ctx.env.NOVA_SMOKE_INVITE ?? "";
  return [
    {
      id: "postdeploy_prerequisites",
      name: "Deployment URL + synthetic-account invite available",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 10_000,
      fn: postdeployPrerequisites,
    },
    {
      id: "readyz",
      name: "Public /readyz returns ready:true",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 30_000,
      fn: readyz,
    },
    {
      id: "ops_status_authed",
      name: "Authenticated /v1/ops/status (operator session, leak spot-check)",
      category: "privacy",
      severity: "P1",
      required: false,
      timeoutMs: 30_000,
      fn: opsStatusAuthed,
    },
    {
      id: "smoke",
      name: "ops:smoke — synthetic end-to-end walk (self-deleting synthetic account)",
      category: "functional",
      severity: "P0",
      required: true,
      timeoutMs: 15 * MIN,
      command: {
        cmd: "pnpm",
        args: ["--filter", "@nova/api", "ops:smoke", "--", `--base-url=${base}`],
        env: invite ? { NOVA_SMOKE_INVITE: invite } : undefined,
      },
    },
  ];
}

/** Recovery gate: verify (incl. expected wrong-key failure) → guarded
 * scratch restore → migrate no-op → media:verify → optional post-restore
 * smoke. Never restores over production (scratch guard blocks first). */
function recoveryChecks(ctx: RunContext): CheckSpec[] {
  const dir = ctx.flags["backup-dir"] ?? "";
  const stamp = ctx.flags.stamp ?? "";
  const base = ctx.flags["base-url"] ?? "";
  return [
    {
      id: "recovery_prerequisites",
      name: "Sealed backup + keys + scratch target configured",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 10_000,
      fn: recoveryPrerequisites,
    },
    {
      id: "scratch_guard",
      name: "Restore target classifies as LOCAL SCRATCH (never production)",
      category: "recovery",
      severity: "P0",
      required: true,
      timeoutMs: 2 * MIN,
      fn: scratchTargetGuard,
    },
    {
      id: "backup_verify",
      name: "backup:verify — manifest schema + HMAC + hashes + sizes + decrypt",
      category: "backup",
      severity: "P0",
      required: true,
      timeoutMs: 10 * MIN,
      command: {
        cmd: "pnpm",
        args: ["--filter", "@nova/api", "backup:verify", "--", `--dir=${dir}`, `--stamp=${stamp}`],
      },
    },
    {
      id: "backup_verify_wrong_key",
      name: "backup:verify with a WRONG key must fail (expected failure)",
      category: "backup",
      severity: "P0",
      required: true,
      timeoutMs: 10 * MIN,
      command: {
        cmd: "pnpm",
        args: ["--filter", "@nova/api", "backup:verify", "--", `--dir=${dir}`, `--stamp=${stamp}`],
        env: { NOVA_BACKUP_KEY: wrongBackupKey() },
        expectFailure: true,
      },
    },
    {
      id: "restore_scratch",
      name: "scripts/restore.sh into the scratch target (guarded, verified-first)",
      category: "recovery",
      severity: "P0",
      required: true,
      timeoutMs: 30 * MIN,
      command: {
        cmd: "bash",
        args: ["scripts/restore.sh", dir, stamp],
        env: { NOVA_RESTORE_CONFIRM: "RESTORE" },
      },
    },
    {
      id: "post_restore_migrate",
      name: "db:migrate after restore (must no-op cleanly)",
      category: "recovery",
      severity: "P1",
      required: true,
      timeoutMs: 10 * MIN,
      command: { cmd: "pnpm", args: ["db:migrate"] },
    },
    {
      id: "media_verify",
      name: "media:verify — every blob present AND decryptable with the data key",
      category: "media",
      severity: "P1",
      required: true,
      timeoutMs: 20 * MIN,
      command: { cmd: "pnpm", args: ["--filter", "@nova/api", "media:verify"] },
    },
    {
      id: "post_restore_smoke",
      name: "post-restore ops:smoke (only when --base-url points at the restored stack)",
      category: "functional",
      severity: "P2",
      required: false,
      timeoutMs: 15 * MIN,
      ...(base
        ? {
            command: {
              cmd: "pnpm",
              args: ["--filter", "@nova/api", "ops:smoke", "--", `--base-url=${base}`],
            },
          }
        : {
            fn: async () => ({
              status: "skipped" as const,
              summary: "no --base-url for the restored stack (safe: run separately once it serves traffic)",
            }),
          }),
    },
  ];
}

export function checksForMode(mode: Mode, ctx: RunContext): CheckSpec[] {
  switch (mode) {
    case "pr":
      return prChecks();
    case "predeploy":
      return predeployChecks();
    case "postdeploy":
      return postdeployChecks(ctx);
    case "recovery":
      return recoveryChecks(ctx);
  }
}
