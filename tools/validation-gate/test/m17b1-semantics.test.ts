import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opsStatusAuthed, postdeployPrerequisites } from "../src/checks/postdeploy.js";
import { recoveryPrerequisites } from "../src/checks/recovery.js";
import { checksForMode } from "../src/config.js";
import { runGate } from "../src/runner.js";
import type { CommandResult, CommandRunner, RunContext } from "../src/types.js";

/**
 * M17B.1 — gate-integrity hardening tests (findings 1–3).
 * Finding 4 (skip provenance) lives in outcome.test.ts / report.test.ts.
 */

const okRun: CommandResult = { code: 0, timedOut: false, durationMs: 5, stdoutExcerpt: "", stderrExcerpt: "" };
const failRun: CommandResult = { code: 1, timedOut: false, durationMs: 5, stdoutExcerpt: "", stderrExcerpt: "boom" };

/** Fake command runner recording which commands ran. */
function fakeRunner(result: CommandResult = okRun): { runner: CommandRunner; ran: string[] } {
  const ran: string[] = [];
  const runner: CommandRunner = async (spec) => {
    ran.push([spec.cmd, ...spec.args].join(" "));
    return result;
  };
  return { runner, ran };
}

const ctx = (over: Partial<RunContext>): RunContext => ({
  repoRoot: process.cwd(),
  mode: "predeploy",
  flags: {},
  env: {} as NodeJS.ProcessEnv,
  runCommand: fakeRunner().runner,
  ...over,
});

/** A production-safe, fully-supplied predeploy env (fake placeholder values;
 * never real secrets). */
const safeFullEnv = (): NodeJS.ProcessEnv =>
  ({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://fake:fake@localhost:5432/fake",
    REDIS_URL: "redis://localhost:6379",
    NOVA_ENCRYPTION_KEY: "a".repeat(64),
    NOVA_BACKUP_KEY: "b".repeat(64),
    NOVA_ALPHA_INVITE_CODE: "fake-invite-code",
    NOVA_MEDIA_STORE: "fs",
    NOVA_MEDIA_FS_ROOT: "/tmp/fake-media",
  }) as NodeJS.ProcessEnv;

describe("finding 2: unsafe supplied config cannot hide behind missing prerequisites", () => {
  const gate = async (env: NodeJS.ProcessEnv, runner = fakeRunner()) => {
    const c = ctx({ env, runCommand: runner.runner });
    return { report: await runGate({ mode: "predeploy", ctx: c, checks: checksForMode("predeploy", c) }), runner };
  };

  it("missing DATABASE_URL + NOVA_SIGNUP=open → FAIL, not BLOCKED", async () => {
    const env = { NODE_ENV: "production", NOVA_SIGNUP: "open" } as NodeJS.ProcessEnv;
    const { report } = await gate(env);
    expect(report.outcome).toBe("FAIL");
    const safety = report.checks.find((c) => c.id === "config_safety");
    expect(safety?.status).toBe("failed");
    expect(safety?.summary).toContain("NOVA_SIGNUP=open");
    // Missing infra is STILL reported (pure prereq check ran too).
    expect(report.checks.find((c) => c.id === "predeploy_prerequisites")?.status).toBe("blocked");
  });

  it("missing media bucket + redaction off → FAIL", async () => {
    const env = {
      NODE_ENV: "production",
      NOVA_REDACTION: "off",
      NOVA_MEDIA_STORE: "s3",
    } as NodeJS.ProcessEnv;
    const { report } = await gate(env);
    expect(report.outcome).toBe("FAIL");
    expect(report.checks.find((c) => c.id === "config_safety")?.summary).toContain("NOVA_REDACTION=off");
  });

  it("identical encryption/backup keys + unsafe override → FAIL even with everything else missing", async () => {
    const env = {
      NOVA_ENCRYPTION_KEY: "c".repeat(64),
      NOVA_BACKUP_KEY: "c".repeat(64),
      NOVA_ALLOW_UNSAFE_REDACTION: "yes",
    } as NodeJS.ProcessEnv;
    const { report } = await gate(env);
    expect(report.outcome).toBe("FAIL");
  });

  it("only missing infrastructure with SAFE supplied config → BLOCKED (and preflight never runs)", async () => {
    const env = { NODE_ENV: "production", NOVA_SIGNUP: "invite" } as NodeJS.ProcessEnv;
    const { report, runner } = await gate(env);
    expect(report.outcome).toBe("BLOCKED");
    expect(report.checks.find((c) => c.id === "config_safety")?.status).toBe("passed");
    const preflight = report.checks.find((c) => c.id === "preflight");
    expect(preflight?.status).toBe("skipped");
    expect(preflight?.skip_reason).toBe("cascade");
    expect(preflight?.caused_by_check_id).toBe("predeploy_prerequisites");
    expect(runner.ran).toHaveLength(0); // ops:preflight never spawned
  });

  it("complete safe config → continues to preflight (command actually runs)", async () => {
    const { report, runner } = await gate(safeFullEnv());
    expect(runner.ran.join(" ")).toContain("ops:preflight");
    expect(report.outcome).toBe("PASS");
  });

  it("complete but UNSAFE config → FAIL before preflight (preflight cascade-skipped)", async () => {
    const env = { ...safeFullEnv(), NOVA_SIGNUP: "open" } as NodeJS.ProcessEnv;
    const { report, runner } = await gate(env);
    expect(report.outcome).toBe("FAIL");
    expect(runner.ran).toHaveLength(0);
    expect(report.checks.find((c) => c.id === "preflight")?.status).toBe("skipped");
  });
});

describe("finding 3: authenticated /v1/ops/status is mandatory for post-deploy", () => {
  it("prerequisites: missing NOVA_VALIDATE_SESSION_TOKEN → BLOCKED naming the credential", async () => {
    const out = await postdeployPrerequisites(
      ctx({ mode: "postdeploy", flags: { "base-url": "http://localhost:9", invite: "x" } }),
    );
    expect(out.status).toBe("blocked");
    expect(out.blockingReasons?.join(" ")).toContain("NOVA_VALIDATE_SESSION_TOKEN");
  });

  it("the check is required in the postdeploy config", async () => {
    const c = ctx({ mode: "postdeploy" });
    const spec = checksForMode("postdeploy", c).find((s) => s.id === "ops_status_authed");
    expect(spec?.required).toBe(true);
    expect(spec?.category).toBe("privacy");
  });

  describe("against a local fake status endpoint", () => {
    let server: Server;
    let base = "";
    let body = "{}";
    let statusCode = 200;

    beforeAll(async () => {
      server = createServer((req, res) => {
        res.writeHead(statusCode, { "content-type": "application/json" });
        res.end(body);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const call = () =>
      opsStatusAuthed(
        ctx({
          mode: "postdeploy",
          flags: { "base-url": base },
          env: { NOVA_VALIDATE_SESSION_TOKEN: "fake-operator-token-123" } as NodeJS.ProcessEnv,
        }),
      );

    it("valid credential + clean JSON contract → passed", async () => {
      statusCode = 200;
      body = JSON.stringify({ time: "t", queues: { enrichment: { ok: true } }, features: {} });
      const out = await call();
      expect(out.status).toBe("passed");
    });

    it("HTTP error → FAIL", async () => {
      statusCode = 503;
      body = "{}";
      expect((await call()).status).toBe("failed");
    });

    it("non-JSON body (contract violation) → FAIL", async () => {
      statusCode = 200;
      body = "<html>login</html>";
      expect((await call()).status).toBe("failed");
    });

    it("raw infrastructure error in body → FAIL (schema/pattern layer, not sanitizer diff)", async () => {
      statusCode = 200;
      body = JSON.stringify({ checks: { redis: { error: "connect ECONNREFUSED 10.0.0.9:6379" } } });
      const out = await call();
      expect(out.status).toBe("failed");
      expect(out.summary).toContain("forbidden raw-infrastructure");
    });

    it("DSN / captured content in body → FAIL", async () => {
      statusCode = 200;
      body = JSON.stringify({ note: "postgres://user:leakedpw@db.internal/nova" });
      expect((await call()).status).toBe("failed");

      body = JSON.stringify({ shot: "DATA:image/png;base64,AAAA" });
      expect((await call()).status).toBe("failed");
    });
  });
});

describe("finding 1: recovery cannot PASS without post-restore smoke", () => {
  const fullRecoveryEnv = (): NodeJS.ProcessEnv =>
    ({
      NOVA_BACKUP_KEY: "d".repeat(64),
      NOVA_ENCRYPTION_KEY: "e".repeat(64),
      DATABASE_URL: "postgres://fake:fake@localhost:5432/scratch",
    }) as NodeJS.ProcessEnv;

  it("missing --restored-base-url → BLOCKED naming the mandatory smoke", async () => {
    const out = await recoveryPrerequisites(
      ctx({ mode: "recovery", flags: { "backup-dir": "/x", stamp: "s" }, env: fullRecoveryEnv() }),
    );
    expect(out.status).toBe("blocked");
    expect(out.blockingReasons?.join(" ")).toContain("--restored-base-url");
  });

  it("non-loopback restored URL without explicit acknowledgment → BLOCKED", async () => {
    const out = await recoveryPrerequisites(
      ctx({
        mode: "recovery",
        flags: { "backup-dir": "/x", stamp: "s", "restored-base-url": "https://api.prod.example.com" },
        env: fullRecoveryEnv(),
      }),
    );
    expect(out.status).toBe("blocked");
    expect(out.blockingReasons?.join(" ")).toContain("loopback");
  });

  it("loopback restored URL + full prerequisites (incl. invite) → passed", async () => {
    const out = await recoveryPrerequisites(
      ctx({
        mode: "recovery",
        flags: { "backup-dir": "/x", stamp: "s", "restored-base-url": "http://localhost:3001", invite: "fake-invite" },
        env: fullRecoveryEnv(),
      }),
    );
    expect(out.status).toBe("passed");
  });

  // Phase A correction: the synthetic invite is a hard prerequisite.
  it("missing synthetic invite → BLOCKED naming the prerequisite (never its value)", async () => {
    const out = await recoveryPrerequisites(
      ctx({
        mode: "recovery",
        flags: { "backup-dir": "/x", stamp: "s", "restored-base-url": "http://localhost:3001" },
        env: fullRecoveryEnv(),
      }),
    );
    expect(out.status).toBe("blocked");
    expect(out.blockingReasons?.join(" ")).toContain("--invite or NOVA_SMOKE_INVITE");
  });

  it("invite via CLI flag OR environment satisfies the prerequisite", async () => {
    const viaFlag = await recoveryPrerequisites(
      ctx({
        mode: "recovery",
        flags: { "backup-dir": "/x", stamp: "s", "restored-base-url": "http://localhost:3001", invite: "flag-invite-1" },
        env: fullRecoveryEnv(),
      }),
    );
    expect(viaFlag.status).toBe("passed");
    const viaEnv = await recoveryPrerequisites(
      ctx({
        mode: "recovery",
        flags: { "backup-dir": "/x", stamp: "s", "restored-base-url": "http://localhost:3001" },
        env: { ...fullRecoveryEnv(), NOVA_SMOKE_INVITE: "env-invite-1" } as NodeJS.ProcessEnv,
      }),
    );
    expect(viaEnv.status).toBe("passed");
  });

  it("the smoke child command receives the invite via env only — never argv/description/reports", async () => {
    const INVITE = "sup3r-s3cret-invite-value";
    const flags = { "backup-dir": "/x", stamp: "s", "restored-base-url": "http://localhost:3001", invite: INVITE };
    const c = ctx({ mode: "recovery", flags, env: fullRecoveryEnv() });
    const spec = checksForMode("recovery", c).find((s) => s.id === "post_restore_smoke")!;
    // Passed through the child env…
    expect(spec.command?.env?.NOVA_SMOKE_INVITE).toBe(INVITE);
    // …but never in argv (command descriptions are built from argv).
    expect(spec.command?.args.join(" ")).not.toContain(INVITE);
    // And a real run whose output echoes the invite still can't leak it into
    // the report: child-env values are sanitized as secrets.
    const echoing = await runGate({
      mode: "recovery",
      ctx: { ...c, runCommand: (await import("../src/checks/command.js")).runCommand },
      checks: [
        {
          ...spec,
          timeoutMs: 30_000,
          command: {
            cmd: process.execPath,
            args: ["-e", "console.log('invite is ' + process.env.NOVA_SMOKE_INVITE)"],
            env: { NOVA_SMOKE_INVITE: INVITE },
          },
        },
      ],
    });
    expect(JSON.stringify(echoing)).not.toContain(INVITE);
  });

  it("post_restore_smoke is REQUIRED/protected in config; smoke failure → FAIL, success → PASS path", async () => {
    const flags = { "backup-dir": "/x", stamp: "s", "restored-base-url": "http://localhost:3001", invite: "fake-invite" };
    const c = ctx({ mode: "recovery", flags, env: fullRecoveryEnv() });
    const spec = checksForMode("recovery", c).find((s) => s.id === "post_restore_smoke");
    expect(spec?.required).toBe(true);
    expect(spec?.category).toBe("recovery"); // protected: even P3 failures FAIL
    expect(spec?.command?.args.join(" ")).toContain("--base-url=http://localhost:3001");

    // Unreachable/failing restored stack → the required smoke fails → FAIL.
    const failure = await runGate({
      mode: "recovery",
      ctx: { ...c, runCommand: fakeRunner(failRun).runner },
      checks: [spec!],
    });
    expect(failure.outcome).toBe("FAIL");

    // Healthy restored stack → smoke passes.
    const success = await runGate({
      mode: "recovery",
      ctx: { ...c, runCommand: fakeRunner(okRun).runner },
      checks: [spec!],
    });
    expect(success.checks[0].status).toBe("passed");
    expect(success.outcome).toBe("PASS");
  });
});
