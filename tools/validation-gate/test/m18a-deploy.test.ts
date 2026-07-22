import { describe, expect, it } from "vitest";
import { checksForMode } from "../src/config.js";
import { runGate } from "../src/runner.js";
import type { CommandResult, CommandSpec, RunContext } from "../src/types.js";

/**
 * M18A.1 finding 3 — `validate:deploy` orchestration. Proves the correct
 * order (config-safety FIRST → prereqs → db:migrate ONCE → ops:preflight →
 * zero-pending confirm) and, critically, that an UNSAFE config FAILs BEFORE
 * any migration runs. Uses a fake command runner so `db:migrate` /
 * `ops:preflight` / `db:migrate:status` never touch a real database.
 */

function fakeRunner(behavior: (cmd: string) => number) {
  const ran: string[] = [];
  const runner = async (spec: CommandSpec): Promise<CommandResult> => {
    const line = [spec.cmd, ...spec.args].join(" ");
    ran.push(line);
    const code = behavior(line);
    return { code, timedOut: false, durationMs: 3, stdoutExcerpt: "ok", stderrExcerpt: code ? "boom" : "" };
  };
  return { runner, ran };
}

const safeEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x",
    REDIS_URL: "redis://x",
    NOVA_ENCRYPTION_KEY: "a".repeat(64),
    NOVA_BACKUP_KEY: "b".repeat(64),
    NOVA_ALPHA_INVITE_CODE: "invite-123",
    NOVA_MEDIA_STORE: "fs",
    NOVA_MEDIA_FS_ROOT: "/data/media",
    NOVA_SIGNUP: "invite",
    NOVA_REDACTION: "on",
    NOVA_IMAGE_REDACTION: "on",
    ...over,
  }) as NodeJS.ProcessEnv;

function ctxFor(env: NodeJS.ProcessEnv, behavior: (cmd: string) => number) {
  const { runner, ran } = fakeRunner(behavior);
  const ctx: RunContext = {
    repoRoot: process.cwd(),
    mode: "deploy",
    flags: {},
    env,
    runCommand: runner,
    runtime: { extraSecrets: [] },
  };
  return { ctx, ran };
}

async function deploy(env: NodeJS.ProcessEnv, behavior: (cmd: string) => number = () => 0) {
  const { ctx, ran } = ctxFor(env, behavior);
  const report = await runGate({ mode: "deploy", ctx, checks: checksForMode("deploy", ctx) });
  return { report, ran };
}

describe("M18A.1 finding 3: validate:deploy orchestration", () => {
  it("safe config, current DB → PASS; runs migrate → preflight → status in order", async () => {
    const { report, ran } = await deploy(safeEnv());
    expect(report.outcome).toBe("PASS");
    expect(ran).toEqual([
      "pnpm db:migrate",
      "pnpm --filter @nova/api ops:preflight",
      "pnpm --filter @nova/api db:migrate:status",
    ]);
  });

  it("UNSAFE config (open signup) → FAIL and db:migrate is NEVER executed", async () => {
    const { report, ran } = await deploy(safeEnv({ NOVA_SIGNUP: "open" }));
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "config_safety")!.status).toBe("failed");
    // The migration (and everything after) is cascade-skipped — no migration
    // is applied under an unsafe configuration.
    expect(ran).toHaveLength(0);
    expect(report.checks.find((c) => c.id === "migrate")!.status).toBe("skipped");
  });

  it("missing operator prerequisites → BLOCKED before migrate runs (exit 2)", async () => {
    const env = safeEnv();
    delete env.NOVA_ENCRYPTION_KEY;
    const { report, ran } = await deploy(env);
    expect(report.outcome).toBe("BLOCKED");
    expect(ran).toHaveLength(0);
  });

  it("migration failure → FAIL; preflight + status cascade-skipped", async () => {
    const { report, ran } = await deploy(safeEnv(), (cmd) => (cmd.includes("db:migrate") && !cmd.includes("status") ? 1 : 0));
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "migrate")!.status).toBe("failed");
    expect(report.checks.find((c) => c.id === "preflight")!.status).toBe("skipped");
    expect(report.checks.find((c) => c.id === "migrations_current")!.status).toBe("skipped");
    expect(ran).toEqual(["pnpm db:migrate"]);
  });

  it("pending migrations left after migrate (status non-zero) → FAIL at the zero-pending confirm", async () => {
    const { report } = await deploy(safeEnv(), (cmd) => (cmd.includes("db:migrate:status") ? 2 : 0));
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "migrations_current")!.status).toBe("failed");
  });

  it("config safety is a PURE check that runs before the migrate command", async () => {
    const specs = checksForMode("deploy", ctxFor(safeEnv(), () => 0).ctx);
    const ids = specs.map((s) => s.id);
    expect(ids.indexOf("config_safety")).toBeLessThan(ids.indexOf("migrate"));
    expect(specs.find((s) => s.id === "config_safety")!.pure).toBe(true);
    expect(specs.find((s) => s.id === "migrate")!.pure).toBeUndefined();
  });
});
