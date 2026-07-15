import { describe, expect, it } from "vitest";
import { runCommand } from "../src/checks/command.js";
import { runGate } from "../src/runner.js";
import type { CheckSpec, RunContext } from "../src/types.js";

/** Real (tiny) subprocesses via `node -e` — no mocking of child_process. */
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  repoRoot: process.cwd(),
  mode: "pr",
  flags: {},
  env: { ...process.env },
  runCommand,
  ...over,
});

const spec = (over: Partial<CheckSpec>): CheckSpec => ({
  id: "c",
  name: "check",
  category: "unit",
  severity: "P0",
  required: true,
  timeoutMs: 30_000,
  ...over,
});

const node = (script: string, extra: Partial<CheckSpec["command"]> = {}) => ({
  cmd: process.execPath,
  args: ["-e", script],
  ...extra,
});

describe("runner + command execution (M17B §6)", () => {
  it("child exit 0 → passed; non-zero → failed check and FAIL outcome", async () => {
    const ok = await runGate({
      mode: "pr",
      ctx: ctx(),
      checks: [spec({ id: "ok", command: node("process.exit(0)") })],
    });
    expect(ok.checks[0].status).toBe("passed");
    expect(ok.outcome).toBe("PASS");

    const bad = await runGate({
      mode: "pr",
      ctx: ctx(),
      checks: [spec({ id: "bad", command: node("console.error('boom'); process.exit(3)") })],
    });
    expect(bad.checks[0].status).toBe("failed");
    expect(bad.checks[0].summary).toContain("exit 3");
    expect(bad.outcome).toBe("FAIL");
  });

  it("command timeout → failed (and the child is terminated)", async () => {
    const report = await runGate({
      mode: "pr",
      ctx: ctx(),
      checks: [spec({ id: "slow", timeoutMs: 500, command: node("setTimeout(()=>{}, 60000)") })],
    });
    expect(report.checks[0].status).toBe("failed");
    expect(report.checks[0].summary).toContain("timed out");
    expect(report.outcome).toBe("FAIL");
  }, 20_000);

  it("expected failure: command fails → check PASSES; unexpected success → check FAILS", async () => {
    const good = await runGate({
      mode: "recovery",
      ctx: ctx(),
      checks: [spec({ id: "wrong_key", category: "backup", command: node("process.exit(2)", { expectFailure: true }) })],
    });
    expect(good.checks[0].status).toBe("passed");
    expect(good.checks[0].summary).toContain("failed as expected");

    const bad = await runGate({
      mode: "recovery",
      ctx: ctx(),
      checks: [spec({ id: "wrong_key", category: "backup", command: node("process.exit(0)", { expectFailure: true }) })],
    });
    expect(bad.checks[0].status).toBe("failed");
    expect(bad.checks[0].summary).toContain("UNEXPECTED SUCCESS");
    expect(bad.outcome).toBe("FAIL");
  });

  it("a blocked required prerequisite → BLOCKED, later checks cascade-skip with a documented reason", async () => {
    const report = await runGate({
      mode: "postdeploy",
      ctx: ctx(),
      checks: [
        spec({
          id: "postdeploy_prerequisites",
          fn: async () => ({
            status: "blocked",
            summary: "missing --base-url (no deployed Nova API to validate)",
            blockingReasons: ["missing --base-url"],
          }),
        }),
        spec({ id: "smoke", category: "functional", command: node("process.exit(0)") }),
      ],
    });
    expect(report.outcome).toBe("BLOCKED");
    expect(report.blocking_reasons.join(" ")).toContain("missing --base-url");
    expect(report.checks[1].status).toBe("skipped");
    expect(report.checks[1].summary).toContain("postdeploy_prerequisites");
  });

  it("missing recovery scratch target → BLOCKED via real prerequisite fn", async () => {
    const { recoveryPrerequisites } = await import("../src/checks/recovery.js");
    const out = await recoveryPrerequisites(
      ctx({ mode: "recovery", flags: {}, env: {} as NodeJS.ProcessEnv }),
    );
    expect(out.status).toBe("blocked");
    expect(out.blockingReasons?.join(" ")).toContain("--backup-dir");
    expect(out.blockingReasons?.join(" ")).toContain("DATABASE_URL");
  });

  it("secrets in child stdout/stderr are redacted in the stored evidence", async () => {
    const key = "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
    const report = await runGate({
      mode: "pr",
      ctx: ctx(),
      checks: [
        spec({
          id: "leaky",
          command: node(
            `console.log('key=${key}'); console.error('dsn postgres://u:p4sswrd@h/db'); process.exit(1)`,
          ),
        }),
      ],
    });
    const s = JSON.stringify(report);
    expect(s).not.toContain(key);
    expect(s).not.toContain("p4sswrd");
  });

  it("vitest totals are parsed into observed metrics", async () => {
    const report = await runGate({
      mode: "pr",
      ctx: ctx(),
      checks: [spec({ id: "unit", command: node(`console.log('Tests  211 passed | 1 skipped (212)')`) })],
    });
    expect(report.metrics.unit_tests_passed).toBe(211);
    expect(report.metrics.unit_tests_skipped).toBe(1);
    expect(report.metrics).toHaveProperty("unit_duration_ms");
  });
});
