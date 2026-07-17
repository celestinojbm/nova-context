import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checksForMode } from "../src/config.js";
import { runGate } from "../src/runner.js";
import type { CheckSpec, CommandRunner, RunContext } from "../src/types.js";

/**
 * M18A §5 — in-gate synthetic session lifecycle (approach B), proven against
 * a real local HTTP server that implements the API surface the bootstrap
 * uses: signup (invite-gated), login, authed /v1/ops/status, /readyz, and
 * the real account-deletion flow. Assertions cover:
 *   - cleanup on success AND on mid-validation failure (alwaysRun);
 *   - the token/password never reaching the report;
 *   - account deletion + session revocation actually proven;
 *   - rerun idempotency (unique account per run);
 *   - approach A passthrough (pre-supplied token ⇒ no account created).
 */

interface FakeApiState {
  invite: string;
  accounts: Map<string, { password: string; deleted: boolean }>;
  sessions: Map<string, string>; // token -> email
  statusMode: "ok" | "error";
  signups: string[];
}

function makeFakeApi(state: FakeApiState): Server {
  const readBody = (req: IncomingMessage): Promise<Record<string, string>> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const bearer = (req: IncomingMessage): string | null =>
    req.headers.authorization?.replace(/^Bearer /, "") ?? null;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    if (url === "/readyz") return send(200, { ready: true });
    if (url === "/v1/auth/signup" && req.method === "POST") {
      const b = await readBody(req);
      if (b.invite_code !== state.invite) return send(403, { error: "invite required" });
      if (state.accounts.has(b.email!)) return send(409, { error: "exists" });
      state.accounts.set(b.email!, { password: b.password!, deleted: false });
      state.signups.push(b.email!);
      return send(201, { id: b.email });
    }
    if (url === "/v1/auth/login" && req.method === "POST") {
      const b = await readBody(req);
      const acct = state.accounts.get(b.email!);
      if (!acct || acct.deleted || acct.password !== b.password) return send(401, { error: "no" });
      const token = `tok-${Math.random().toString(36).slice(2)}`;
      state.sessions.set(token, b.email!);
      return send(200, { token });
    }
    if (url === "/v1/ops/status") {
      const t = bearer(req);
      const email = t ? state.sessions.get(t) : undefined;
      if (!email || state.accounts.get(email)?.deleted) return send(401, { error: "unauthorized" });
      if (state.statusMode === "error") return send(503, {});
      return send(200, { time: "t", queues: { enrichment: { ok: true } }, features: {} });
    }
    if (url === "/v1/auth/account/delete" && req.method === "POST") {
      const t = bearer(req);
      const email = t ? state.sessions.get(t) : undefined;
      const b = await readBody(req);
      const acct = email ? state.accounts.get(email) : undefined;
      if (!acct || acct.deleted) return send(401, {});
      if (b.confirm !== "DELETE" || b.password !== acct.password) return send(400, {});
      acct.deleted = true;
      // Real flow revokes every session for the account:
      for (const [tok, em] of [...state.sessions]) if (em === email) state.sessions.delete(tok);
      return send(200, { deleted: true });
    }
    return send(404, {});
  });
}

/** ops:smoke child process replaced by a stub runner (its real behavior has
 * its own suite); everything else in the postdeploy list is fn-based. */
const stubRunner =
  (smokeExit: number): CommandRunner =>
  async () => ({
    code: smokeExit,
    timedOut: false,
    durationMs: 5,
    stdoutExcerpt: "SMOKE OK (stub)",
    stderrExcerpt: "",
  });

describe("M18A §5: in-gate synthetic session (bootstrap → authed status → cleanup)", () => {
  const state: FakeApiState = {
    invite: "syn-invite-9f",
    accounts: new Map(),
    sessions: new Map(),
    statusMode: "ok",
    signups: [],
  };
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = makeFakeApi(state);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    state.accounts.clear();
    state.sessions.clear();
    state.signups.length = 0;
    state.statusMode = "ok";
  });

  const makeCtx = (over: Partial<RunContext> = {}): RunContext => ({
    repoRoot: process.cwd(),
    mode: "postdeploy",
    flags: { "base-url": base, invite: state.invite },
    env: {} as NodeJS.ProcessEnv,
    runCommand: stubRunner(0),
    runtime: { extraSecrets: [] },
    ...over,
  });

  const run = (ctx: RunContext, checks?: CheckSpec[]) =>
    runGate({ mode: "postdeploy", ctx, checks: checks ?? checksForMode("postdeploy", ctx) });

  it("success path: bootstrap → authed status → smoke → cleanup PASS; account deleted; sessions revoked", async () => {
    const ctx = makeCtx();
    const report = await run(ctx);
    expect(report.outcome).toBe("PASS");
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["postdeploy_prerequisites", "passed"],
      ["readyz", "passed"],
      ["synthetic_session_bootstrap", "passed"],
      ["ops_status_authed", "passed"],
      ["smoke", "passed"],
      ["synthetic_session_cleanup", "passed"],
    ]);
    expect(state.signups).toHaveLength(1);
    expect([...state.accounts.values()][0]!.deleted).toBe(true);
    expect(state.sessions.size).toBe(0); // every session revoked
  });

  it("mid-validation failure: authed status 503 → FAIL, smoke cascade-skipped, cleanup STILL runs and deletes the account", async () => {
    state.statusMode = "error";
    const ctx = makeCtx();
    const report = await run(ctx);
    expect(report.outcome).toBe("FAIL");
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.ops_status_authed!.status).toBe("failed");
    expect(byId.smoke!.status).toBe("skipped"); // cascade
    expect(byId.synthetic_session_cleanup!.status).toBe("passed"); // alwaysRun
    expect([...state.accounts.values()][0]!.deleted).toBe(true);
    expect(state.sessions.size).toBe(0);
  });

  it("token, password, and invite never appear anywhere in the report", async () => {
    const ctx = makeCtx();
    const report = await run(ctx);
    const serialized = JSON.stringify(report);
    for (const secret of ctx.runtime.extraSecrets) {
      expect(secret.length).toBeGreaterThan(8);
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(state.invite);
    // And no check spec put the token into argv (fn-based checks only).
    expect(serialized).not.toContain("tok-");
  });

  it("rerun is idempotent: each run mints a unique account and cleans it up", async () => {
    await run(makeCtx());
    await run(makeCtx());
    expect(state.signups).toHaveLength(2);
    expect(new Set(state.signups).size).toBe(2); // unique emails
    expect([...state.accounts.values()].every((a) => a.deleted)).toBe(true);
  });

  it("approach A passthrough: pre-supplied token → no account created, cleanup passes with nothing to clean", async () => {
    // Mint a session directly (an operator-supplied synthetic session).
    state.accounts.set("op@nova-validate.invalid", { password: "x", deleted: false });
    state.sessions.set("operator-token-1", "op@nova-validate.invalid");
    const ctx = makeCtx({
      env: { NOVA_VALIDATE_SESSION_TOKEN: "operator-token-1" } as NodeJS.ProcessEnv,
    });
    const report = await run(ctx);
    expect(report.outcome).toBe("PASS");
    const cleanup = report.checks.find((c) => c.id === "synthetic_session_cleanup")!;
    expect(cleanup.status).toBe("passed");
    expect(cleanup.summary).toContain("nothing to clean");
    expect(state.signups).toHaveLength(0);
  });

  it("cleanup failure is a FAIL, never silent (account deletion rejected)", async () => {
    const ctx = makeCtx();
    const checks = checksForMode("postdeploy", ctx);
    // Sabotage: corrupt the stored password after bootstrap so deletion 400s.
    const sabotage: CheckSpec = {
      id: "sabotage",
      name: "corrupt credentials before cleanup (test-only)",
      category: "operations",
      severity: "P3",
      required: false,
      timeoutMs: 5_000,
      fn: async () => {
        for (const acct of state.accounts.values()) acct.password = "changed-behind-our-back";
        return { status: "passed", summary: "sabotaged" };
      },
    };
    const idx = checks.findIndex((c) => c.id === "synthetic_session_cleanup");
    checks.splice(idx, 0, sabotage);
    const report = await run(ctx, checks);
    const cleanup = report.checks.find((c) => c.id === "synthetic_session_cleanup")!;
    expect(cleanup.status).toBe("failed");
    expect(cleanup.summary).toContain("manual cleanup required");
    expect(report.outcome).toBe("FAIL");
  });
});
