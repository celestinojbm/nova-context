import {
  prLocalStack,
  predeployConfigSafety,
  predeployFeaturePosture,
  predeployPrerequisites,
} from "./checks/prerequisites.js";
import {
  opsStatusAuthed,
  postdeployPrerequisites,
  readyz,
  syntheticSessionBootstrap,
  syntheticSessionCleanup,
} from "./checks/postdeploy.js";
import {
  isS3Media,
  recoveryPrerequisites,
  s3RecoveryPrerequisites,
  scratchTargetGuard,
  wrongBackupKey,
} from "./checks/recovery.js";
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

/** Pre-deploy gate. Ordering matters (M17B.1 finding 2): PURE checks —
 * config safety, feature posture, prerequisite presence — inspect only the
 * local environment and ALWAYS run, so an unsafe supplied configuration is
 * reported as FAIL even when unrelated infrastructure values are missing
 * (FAIL > BLOCKED). Only the non-pure ops:preflight cascades — it must not
 * run when prerequisites are missing. */
function predeployChecks(): CheckSpec[] {
  return [
    {
      id: "config_safety",
      name: "Production configuration safety (invite-only, redaction on, no unsafe override, keys distinct)",
      category: "security",
      severity: "P0",
      required: true,
      pure: true,
      timeoutMs: 10_000,
      fn: predeployConfigSafety,
    },
    {
      id: "feature_posture",
      name: "First-deploy feature posture (Notion/cloud/live-QA/transcription OFF)",
      category: "operations",
      severity: "P3",
      required: false,
      pure: true,
      timeoutMs: 10_000,
      fn: predeployFeaturePosture,
    },
    {
      id: "predeploy_prerequisites",
      name: "Operator prerequisites present (names checked, values never printed)",
      category: "operations",
      severity: "P0",
      required: true,
      pure: true,
      timeoutMs: 10_000,
      fn: predeployPrerequisites,
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

/**
 * Deploy orchestration (M18A.1 finding 3). The single command Render's
 * pre-deploy hook runs. It fixes the migration/config ordering bug: config
 * safety is a PURE check that runs FIRST, so an unsafe production config
 * FAILs and cascade-skips the non-pure db:migrate — migrations are NEVER
 * applied before unsafe config is rejected. Order:
 *   1. config safety (pure)      → unsafe config FAILs here, before migrate
 *   2. feature posture (pure)    → informational
 *   3. operator prerequisites (pure)
 *   4. db:migrate                → applies pending migrations exactly once
 *                                  (also proves DB connectivity)
 *   5. ops:preflight             → connectivity + keys + store + zero-pending
 *   6. db:migrate:status         → explicit "0 pending" confirmation
 * Reuses existing checks + the existing migration command; no migration
 * logic is duplicated. BLOCKED/FAIL → non-zero exit → Render aborts the
 * deploy (operator mode: FAIL=1, BLOCKED=2). */
function deployChecks(): CheckSpec[] {
  return [
    {
      id: "config_safety",
      name: "Production configuration safety (invite-only, redaction on, no unsafe override, keys distinct)",
      category: "security",
      severity: "P0",
      required: true,
      pure: true,
      timeoutMs: 10_000,
      fn: predeployConfigSafety,
    },
    {
      id: "feature_posture",
      name: "First-deploy feature posture (Notion/cloud/live-QA/transcription OFF)",
      category: "operations",
      severity: "P3",
      required: false,
      pure: true,
      timeoutMs: 10_000,
      fn: predeployFeaturePosture,
    },
    {
      id: "predeploy_prerequisites",
      name: "Operator prerequisites present (names checked, values never printed)",
      category: "operations",
      severity: "P0",
      required: true,
      pure: true,
      timeoutMs: 10_000,
      fn: predeployPrerequisites,
    },
    {
      // Applies pending migrations exactly once AND proves DB connectivity.
      // Non-pure: a prior config-safety FAIL cascade-skips this — migrations
      // are never applied under an unsafe configuration.
      id: "migrate",
      name: "db:migrate — apply pending migrations (once) against the target database",
      category: "integration",
      severity: "P0",
      required: true,
      timeoutMs: 10 * MIN,
      command: { cmd: "pnpm", args: ["db:migrate"] },
    },
    {
      id: "preflight",
      name: "ops:preflight — connectivity, keys, media store, zero pending migrations, config",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 10 * MIN,
      command: { cmd: "pnpm", args: ["--filter", "@nova/api", "ops:preflight"] },
    },
    {
      // Explicit, distinct "no pending migrations" confirmation AFTER migrate.
      id: "migrations_current",
      name: "db:migrate:status — confirm zero pending migrations",
      category: "integration",
      severity: "P0",
      required: true,
      timeoutMs: 5 * MIN,
      command: { cmd: "pnpm", args: ["--filter", "@nova/api", "db:migrate:status"] },
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
      // M18A §5 (approach B): the authenticated checks use an in-gate
      // synthetic session — created here, held only in memory, destroyed by
      // synthetic_session_cleanup below. A pre-supplied
      // NOVA_VALIDATE_SESSION_TOKEN (approach A) is used as-is instead.
      id: "synthetic_session_bootstrap",
      name: "Synthetic validation session (in-memory bootstrap via invite, or pre-supplied token)",
      category: "security",
      severity: "P1",
      required: true,
      timeoutMs: 60_000,
      fn: syntheticSessionBootstrap,
    },
    {
      // M17B.1 finding 3: MANDATORY — a post-deploy PASS must validate the
      // authenticated status endpoint (an authentication path is a hard
      // prerequisite above; the token itself is bootstrapped in-gate).
      id: "ops_status_authed",
      name: "Authenticated /v1/ops/status (JSON contract + raw-error/leak detection)",
      category: "privacy",
      severity: "P1",
      required: true,
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
    {
      // M18A §5: cleanup ALWAYS runs (never cascade-skipped) so a failure
      // mid-validation cannot leak the synthetic account. Deleting the
      // account revokes its sessions; the check proves post-delete login
      // fails. Required: a leftover synthetic account is a hygiene failure.
      id: "synthetic_session_cleanup",
      name: "Synthetic session destroyed (account deleted, session revoked, cleanup proven)",
      category: "privacy",
      severity: "P1",
      required: true,
      alwaysRun: true,
      timeoutMs: 60_000,
      fn: syntheticSessionCleanup,
    },
  ];
}

/** Recovery gate: verify (incl. expected wrong-key failure) → guarded
 * scratch restore → migrate no-op → media:verify → MANDATORY post-restore
 * smoke against the restored scratch stack (M17B.1 finding 1: recovery can
 * never PASS without functionally testing the restored system). Never
 * restores over production (scratch guard blocks first). */
function recoveryChecks(ctx: RunContext): CheckSpec[] {
  const dir = ctx.flags["backup-dir"] ?? "";
  const stamp = ctx.flags.stamp ?? "";
  const restoredBase = ctx.flags["restored-base-url"] ?? "";
  // Phase A: the synthetic invite is a hard prerequisite (recovery_prerequisites
  // blocks without it) and is passed to ops:smoke EXPLICITLY via the child
  // env — never as an argv (command descriptions stay invite-free), and the
  // sanitizer treats child-env values + NOVA_SMOKE_INVITE as secrets.
  const invite = ctx.flags.invite ?? ctx.env.NOVA_SMOKE_INVITE ?? "";
  // M18A.1 finding 2: the S3 media path is wired INTO the gate for s3 stores.
  // fs stores keep the tar-based path (media rides inside the sealed backup,
  // restored by restore.sh; media:verify covers it).
  const s3 = isS3Media(ctx.env);

  const checks: CheckSpec[] = [
    {
      id: "recovery_prerequisites",
      name: "Sealed backup + keys + scratch target configured",
      category: "operations",
      severity: "P0",
      required: true,
      timeoutMs: 10_000,
      fn: recoveryPrerequisites,
    },
  ];

  if (s3) {
    checks.push({
      // Blocks BEFORE any mutation if the s3 backup/scratch config is missing
      // or the scratch store aliases the backup store.
      id: "s3_recovery_prerequisites",
      name: "S3 media backup store + a SEPARATE scratch media destination",
      category: "backup",
      severity: "P0",
      required: true,
      timeoutMs: 10_000,
      fn: s3RecoveryPrerequisites,
    });
  }

  checks.push(
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
  );

  if (s3) {
    checks.push(
      {
        // S3 media inventory verification (HMAC + object hashes) against the
        // backup store — a missing/incomplete/altered backup is a FAIL.
        id: "media_backup_verify",
        name: "media:verify-backup-s3 — inventory MAC + completeness + object hashes",
        category: "backup",
        severity: "P0",
        required: true,
        timeoutMs: 10 * MIN,
        command: {
          cmd: "pnpm",
          args: ["--filter", "@nova/api", "media:verify-backup-s3", "--", `--stamp=${stamp}`, `--dir=${dir}`],
        },
      },
      {
        // Expected-failure: a WRONG backup key must fail media inventory
        // verification (unexpected success FAILS the gate).
        id: "media_backup_verify_wrong_key",
        name: "media:verify-backup-s3 with a WRONG key must fail (expected failure)",
        category: "backup",
        severity: "P0",
        required: true,
        timeoutMs: 10 * MIN,
        command: {
          cmd: "pnpm",
          args: ["--filter", "@nova/api", "media:verify-backup-s3", "--", `--stamp=${stamp}`, `--dir=${dir}`],
          env: { NOVA_BACKUP_KEY: wrongBackupKey() },
          expectFailure: true,
        },
      },
    );
  }

  checks.push(
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
  );

  if (s3) {
    checks.push({
      // S3 media restore into the CONFIGURED scratch store (--apply). Verifies
      // the inventory first and refuses the ORIGINAL primary destination.
      id: "media_restore_s3",
      name: "media:restore-s3 --apply — restore encrypted blobs into the scratch bucket",
      category: "recovery",
      severity: "P1",
      required: true,
      timeoutMs: 20 * MIN,
      command: {
        cmd: "pnpm",
        args: ["--filter", "@nova/api", "media:restore-s3", "--", `--stamp=${stamp}`, `--dir=${dir}`, "--apply"],
      },
    });
  }

  checks.push(
    {
      id: "media_verify",
      name: "media:verify — every blob present AND decryptable with the data key (scratch DB + scratch bucket)",
      category: "media",
      severity: "P1",
      required: true,
      timeoutMs: 20 * MIN,
      command: { cmd: "pnpm", args: ["--filter", "@nova/api", "media:verify"] },
    },
    {
      // M17B.1 finding 1: REQUIRED, protected (category recovery). The
      // restored-stack URL is a hard prerequisite (recovery_prerequisites
      // blocks without it); an unreachable restored stack or failing smoke
      // is a FAIL — recovery can never PASS without this check running.
      id: "post_restore_smoke",
      name: "post-restore ops:smoke against the restored scratch stack (--restored-base-url)",
      category: "recovery",
      severity: "P1",
      required: true,
      timeoutMs: 15 * MIN,
      command: {
        cmd: "pnpm",
        args: ["--filter", "@nova/api", "ops:smoke", "--", `--base-url=${restoredBase}`],
        env: invite ? { NOVA_SMOKE_INVITE: invite } : undefined,
      },
    },
  );

  return checks;
}

export function checksForMode(mode: Mode, ctx: RunContext): CheckSpec[] {
  switch (mode) {
    case "pr":
      return prChecks();
    case "predeploy":
      return predeployChecks();
    case "deploy":
      return deployChecks();
    case "postdeploy":
      return postdeployChecks(ctx);
    case "recovery":
      return recoveryChecks(ctx);
  }
}
