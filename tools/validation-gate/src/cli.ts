import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./checks/command.js";
import { exitCodeFor } from "./outcome.js";
import { toJson } from "./report/json.js";
import { toJUnit } from "./report/junit.js";
import { toMarkdown } from "./report/markdown.js";
import { runGate } from "./runner.js";
import type { Mode, RunContext } from "./types.js";

const HELP = `nova validation gate v0 (M17B)

Usage:
  pnpm validate:pr
  pnpm validate:predeploy
  pnpm validate:deploy       (Render pre-deploy hook: config-safety → prereqs →
                              db:migrate → ops:preflight → 0-pending confirm;
                              unsafe config FAILs BEFORE any migration runs)
  pnpm validate:postdeploy -- --base-url=https://api.example.com [--invite=<code>]
                              (NOVA_VALIDATE_SESSION_TOKEN required — the
                               authenticated /v1/ops/status check is mandatory)
  pnpm validate:recovery   -- --backup-dir=/secure/path --stamp=<stamp> \
                              --restored-base-url=http://localhost:<port> \
                              [--invite=<code>]
                              (post-restore smoke against the restored scratch
                               stack is mandatory for a recovery PASS; its
                               synthetic invite comes from --invite or
                               NOVA_SMOKE_INVITE and is never printed)

Outcomes:
  PASS              all mandatory checks ran and passed
  CONDITIONAL_PASS  mandatory checks passed; an explicitly allowed optional
                    capability is disabled/degraded (never hides a failure)
  FAIL              a required check ran and failed — fix before merge/deploy
  BLOCKED           operator-controlled prerequisites are missing; the gate
                    could not run. BLOCKED is NOT a pass and exits non-zero.

Exit codes: PASS/CONDITIONAL_PASS 0 · FAIL 1 · BLOCKED 1 (pr mode) / 2 (other modes)

Prerequisites per mode:
  pr          local/CI Postgres + Redis only (no cloud credentials, ever)
  predeploy   NODE_ENV=production + operator secrets present (names checked,
              values never printed). Pure config-safety checks run even when
              infrastructure values are missing — unsafe supplied config is
              FAIL, missing infra is BLOCKED (FAIL wins).
  postdeploy  a REAL deployed Nova API (--base-url), an invite for the
              SYNTHETIC smoke account, and NOVA_VALIDATE_SESSION_TOKEN (the
              authenticated /v1/ops/status check is mandatory). Synthetic
              data only — the smoke account self-deletes. NO real user data.
  recovery    a sealed backup (--backup-dir/--stamp), NOVA_BACKUP_KEY,
              NOVA_ENCRYPTION_KEY, a SCRATCH DATABASE_URL (the restore guard
              refuses non-local targets), --restored-base-url for the
              MANDATORY post-restore smoke, and a synthetic invite
              (--invite or NOVA_SMOKE_INVITE). Never restores production.

Reports (never contain secrets or captured content):
  artifacts/validation/<run-id>/report.json | report.md | junit.xml
  artifacts/validation/latest.json | latest.md

Flags: --help · --debug (local only: echoes sanitized check evidence; refused in CI)
`;

function parseArgs(argv: string[]): { mode: Mode | null; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let mode: Mode | null = null;
  for (const a of argv) {
    if (a === "pr" || a === "predeploy" || a === "deploy" || a === "postdeploy" || a === "recovery")
      mode = a;
    else if (a.startsWith("--")) {
      const [k, ...rest] = a.slice(2).split("=");
      if (k) flags[k] = rest.length ? rest.join("=") : "true";
    }
  }
  return { mode, flags };
}

async function main(): Promise<void> {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  if (flags.help !== undefined || !mode) {
    process.stdout.write(HELP);
    process.exit(mode ? 0 : flags.help !== undefined ? 0 : 2);
  }

  const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
  const debug = flags.debug === "true" && !process.env.CI;
  if (flags.debug === "true" && process.env.CI) {
    console.error("--debug is refused in CI (verbose local-only mode; output stays sanitized regardless).");
  }

  const ctx: RunContext = {
    repoRoot,
    mode,
    flags,
    env: process.env,
    runCommand,
    runtime: { extraSecrets: [] },
  };
  console.log(`validation-gate: mode=${mode} (see --help for outcome semantics; no real user data, ever)`);
  const report = await runGate({ mode, ctx });

  // Write reports.
  const outRoot = process.env.NOVA_VALIDATE_OUT_DIR ?? join(repoRoot, "artifacts", "validation");
  const runDir = join(outRoot, report.run_id);
  mkdirSync(runDir, { recursive: true });
  const jsonPath = join(runDir, "report.json");
  const mdPath = join(runDir, "report.md");
  writeFileSync(jsonPath, toJson(report));
  writeFileSync(mdPath, toMarkdown(report));
  const junitPath = join(runDir, "junit.xml");
  writeFileSync(junitPath, toJUnit(report));
  copyFileSync(jsonPath, join(outRoot, "latest.json"));
  copyFileSync(mdPath, join(outRoot, "latest.md"));

  // M18A §4: retain sanitized evidence in the operator's PRIVATE evidence
  // store (ephemeral Render jobs lose their filesystem). Upload failure is
  // loud and never silently claimed as retained.
  let evidenceExit = 0;
  if (process.env.NOVA_VALIDATE_EVIDENCE_S3_BUCKET) {
    const { S3ObjectStore } = await import("@nova/context-engine/object-store");
    const { retainEvidence } = await import("./evidence.js");
    const store = new S3ObjectStore({
      bucket: process.env.NOVA_VALIDATE_EVIDENCE_S3_BUCKET,
      region: process.env.NOVA_VALIDATE_EVIDENCE_S3_REGION ?? "us-east-1",
      endpoint: process.env.NOVA_VALIDATE_EVIDENCE_S3_ENDPOINT,
      accessKeyId: process.env.NOVA_VALIDATE_EVIDENCE_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.NOVA_VALIDATE_EVIDENCE_S3_SECRET_ACCESS_KEY ?? "",
    });
    const retained = await retainEvidence({
      store,
      mode,
      runId: report.run_id,
      outcome: report.outcome,
      gitSha: report.git_sha,
      uploadedAt: report.finished_at,
      files: [{ path: jsonPath }, { path: mdPath }, { path: junitPath }],
      // Scrub the run's minted synthetic secrets AND the evidence
      // endpoint/bucket from any (already sanitized) upload error. The endpoint
      // is registered as the full URL AND its bare host / host:port variants
      // (M18A.1 review): an S3/DNS/socket error renders the host WITHOUT the
      // scheme (e.g. "getaddrinfo ENOTFOUND minio.internal") so the full-URL
      // literal alone would not match. A private resolved IP:port is caught by
      // the sanitizer's private-IP pattern.
      extraSecrets: [
        ...ctx.runtime.extraSecrets,
        ...endpointSecretVariants(process.env.NOVA_VALIDATE_EVIDENCE_S3_ENDPOINT),
        process.env.NOVA_VALIDATE_EVIDENCE_S3_BUCKET,
      ].filter((v): v is string => !!v),
      backupKey: parseBackupKeyLoose(process.env.NOVA_BACKUP_KEY),
      env: process.env,
    });
    if (retained.ok) {
      console.log(
        `evidence retained: ${retained.prefix} (${retained.uploaded.length} files, ${retained.authenticated ? "HMAC-authenticated meta" : "integrity hashes only — NOVA_BACKUP_KEY unset"})`,
      );
      for (const [name, hash] of Object.entries(retained.hashes)) {
        console.log(`  sha256 ${name}: ${hash}`);
      }
    } else {
      // retained.error is already sanitized by retainEvidence.
      console.error(`EVIDENCE RETENTION FAILED: ${retained.error ?? "unknown error"}`);
      console.error("  reports exist ONLY on this (possibly ephemeral) filesystem — do NOT claim full evidence retention.");
      if (process.env.NOVA_VALIDATE_EVIDENCE_REQUIRED === "yes") evidenceExit = 1;
    }
  } else {
    console.log("evidence retention: not configured (NOVA_VALIDATE_EVIDENCE_S3_BUCKET unset) — reports are local only");
  }

  // Console summary (sanitized fields only).
  for (const c of report.checks) {
    const mark =
      c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : c.status === "blocked" ? "⛔" : c.status === "degraded" ? "▽" : "→";
    console.log(`  ${mark} [${c.status}] ${c.id} (${c.duration_ms}ms) — ${c.summary}`);
    if (debug && c.evidence) console.log(`      ${c.evidence.split("\n").join("\n      ")}`);
  }
  for (const r of report.blocking_reasons) console.log(`  blocking: ${r}`);
  for (const w of report.warnings) console.log(`  warning: ${w}`);
  console.log(`\nOUTCOME: ${report.outcome} (mode=${mode})`);
  console.log(`reports: ${runDir}`);
  if (report.outcome === "CONDITIONAL_PASS") {
    console.log("note: CONDITIONAL_PASS — an allowed optional capability is disabled/degraded; mandatory checks all passed.");
  }
  if (report.outcome === "BLOCKED") {
    console.log("note: BLOCKED is not a pass — supply the missing operator prerequisites and re-run.");
  }
  process.exit(Math.max(exitCodeFor(report.outcome, mode), evidenceExit));
}

/** Parse a 32-byte NOVA_BACKUP_KEY (hex or base64) for evidence-meta HMAC.
 * Returns undefined if absent/invalid — retention then falls back to
 * integrity-hash-only meta (honestly marked). */
function parseBackupKeyLoose(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  return key.length === 32 ? key : undefined;
}

/** Every literal spelling of an endpoint that an S3/DNS/socket error might
 * echo: the full URL, the bare host, and host:port. Registering all three as
 * sanitizer extra-secrets means a "getaddrinfo ENOTFOUND <host>" or a
 * "<host>:<port>" error cannot leak the private evidence endpoint (M18A.1
 * review). Returns [] for an unset endpoint. */
function endpointSecretVariants(endpoint: string | undefined): string[] {
  if (!endpoint) return [];
  const out = new Set<string>([endpoint]);
  try {
    const u = new URL(endpoint);
    if (u.hostname) out.add(u.hostname);
    if (u.host) out.add(u.host); // host[:port]
  } catch {
    const bare = endpoint.replace(/^[a-z0-9+.-]+:\/\//i, "").replace(/\/.*$/, "");
    if (bare) {
      out.add(bare);
      out.add(bare.split(":")[0] ?? bare);
    }
  }
  return [...out];
}

main().catch((err) => {
  console.error(`validation-gate crashed: ${(err as Error).message}`);
  process.exit(1);
});
