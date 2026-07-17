import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checksForMode } from "../src/config.js";
import { runGate } from "../src/runner.js";
import { syntheticSessionCleanup } from "../src/checks/postdeploy.js";
import type { CheckSpec, CommandRunner, RunContext } from "../src/types.js";

/**
 * M18A §5 / M18A.1 finding 4 — the in-gate synthetic session lifecycle proven
 * against a real, controllable local HTTP server. Covers the happy path,
 * cleanup after mid-validation failure, login-failure recovery (HTTP + network),
 * unrecoverable cleanup (loud FAIL + sanitized handle), approach-A revocation,
 * rerun idempotency, and secret-freedom on every path.
 *
 * The M18A.1 adversarial-review findings are pinned here too:
 *   - P1: an approach-A logout that leaves the session live (probe 403) is NOT
 *     accepted as revocation — only a literal 401 proves a dead session;
 *   - P2: a committed-but-lost signup (502) is recovered and deleted (no
 *     orphan), while a truly failed signup (500) passes as "likely no orphan"
 *     with a handle — never a false "nothing to clean";
 *   - P3: the invite is a sanitizer extra-secret (absent from every report).
 */

interface FakeApiState {
  invite: string;
  accounts: Map<string, { password: string; deleted: boolean }>;
  sessions: Map<string, string>; // live token -> email
  revoked: Set<string>;
  /** "ok" | "error" (503) | "forbidden" (403 for a LIVE token — authenticated
   *  but not allowed; must NOT be read as revoked, M18A.1 review P1). */
  statusMode: "ok" | "error" | "forbidden";
  /** "ok" (revokes the token) | "noop" (returns 200 but leaves the session
   *  live — a broken logout that must not be trusted as revocation, P1). */
  logoutMode: "ok" | "noop";
  /** "ok" (201, account created) | "commit-then-502" (account IS created but
   *  the response is a lost 502 — a committed-then-lost signup, P2) |
   *  "fail" (500, account NOT created — a truly failed signup, P2). */
  signupMode: "ok" | "commit-then-502" | "fail";
  /** "ok" | "reject" (always 401) | "reject-then-ok" (1st 401, then ok) |
   *  "reset" (destroy socket on the 1st call, then ok). */
  loginMode: "ok" | "reject" | "reject-then-ok" | "reset";
  deleteMode: "ok" | "reject";
  loginCalls: number;
  signups: string[];
}

function freshState(over: Partial<FakeApiState> = {}): FakeApiState {
  return {
    invite: "syn-invite-9f",
    accounts: new Map(),
    sessions: new Map(),
    revoked: new Set(),
    statusMode: "ok",
    logoutMode: "ok",
    signupMode: "ok",
    loginMode: "ok",
    deleteMode: "ok",
    loginCalls: 0,
    signups: [],
    ...over,
  };
}

/** A holder so the server always reads the CURRENT per-test state. */
const ref: { s: FakeApiState } = { s: freshState() };

function makeFakeApi(): Server {
  const stateOf = () => ref.s;
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
      if (b.invite_code !== stateOf().invite) return send(403, { error: "invite required" });
      if (stateOf().accounts.has(b.email!)) return send(409, { error: "exists" });
      // P2: a truly failed signup creates NOTHING and returns a 5xx.
      if (stateOf().signupMode === "fail") return send(500, { error: "signup failed" });
      // P2: a committed-then-lost signup DID create the account, but the
      // caller only sees a 502 — the classic orphan-risk case.
      if (stateOf().signupMode === "commit-then-502") {
        stateOf().accounts.set(b.email!, { password: b.password!, deleted: false });
        stateOf().signups.push(b.email!);
        return send(502, { error: "bad gateway" });
      }
      stateOf().accounts.set(b.email!, { password: b.password!, deleted: false });
      stateOf().signups.push(b.email!);
      return send(201, { id: b.email });
    }

    if (url === "/v1/auth/login" && req.method === "POST") {
      stateOf().loginCalls += 1;
      const first = stateOf().loginCalls === 1;
      if (stateOf().loginMode === "reject") return send(401, { error: "no" });
      if (stateOf().loginMode === "reject-then-ok" && first) return send(401, { error: "no" });
      if (stateOf().loginMode === "reset" && first) {
        req.socket.destroy(); // simulate a network failure on the 1st login
        return;
      }
      const b = await readBody(req);
      const acct = stateOf().accounts.get(b.email!);
      if (!acct || acct.deleted || acct.password !== b.password) return send(401, { error: "no" });
      const token = `tok-${Math.random().toString(36).slice(2)}`;
      stateOf().sessions.set(token, b.email!);
      return send(200, { token });
    }

    if (url === "/v1/auth/logout" && req.method === "POST") {
      const t = bearer(req);
      // P1: a "noop" logout returns 200 but does NOT revoke — the session
      // stays live, so a probe that trusts anything but 401 is fooled.
      if (t && stateOf().logoutMode !== "noop") {
        stateOf().revoked.add(t);
        stateOf().sessions.delete(t);
      }
      return send(200, { ok: true });
    }

    if (url === "/v1/ops/status") {
      const t = bearer(req);
      if (!t || stateOf().revoked.has(t)) return send(401, { error: "unauthorized" });
      const email = stateOf().sessions.get(t);
      if (!email || stateOf().accounts.get(email)?.deleted) return send(401, { error: "unauthorized" });
      // P1: 403 = a LIVE, authenticated token that is merely not authorized.
      // It is the OPPOSITE of revocation and must never be read as "dead".
      if (stateOf().statusMode === "forbidden") return send(403, { error: "forbidden" });
      if (stateOf().statusMode === "error") return send(503, {});
      return send(200, { time: "t", queues: { enrichment: { ok: true } }, features: {} });
    }

    if (url === "/v1/auth/account/delete" && req.method === "POST") {
      if (stateOf().deleteMode === "reject") return send(400, { error: "nope" });
      const t = bearer(req);
      const email = t ? stateOf().sessions.get(t) : undefined;
      const b = await readBody(req);
      const acct = email ? stateOf().accounts.get(email) : undefined;
      if (!acct || acct.deleted) return send(401, {});
      if (b.confirm !== "DELETE" || b.password !== acct.password) return send(400, {});
      acct.deleted = true;
      for (const [tok, em] of [...stateOf().sessions]) if (em === email) stateOf().sessions.delete(tok);
      return send(200, { deleted: true });
    }
    return send(404, {});
  });
}

const stubRunner: CommandRunner = async () => ({
  code: 0,
  timedOut: false,
  durationMs: 5,
  stdoutExcerpt: "SMOKE OK (stub)",
  stderrExcerpt: "",
});

describe("M18A.1 finding 4: synthetic session lifecycle", () => {
  let server: Server;
  let base = "";
  let state: FakeApiState;

  beforeAll(async () => {
    state = freshState();
    ref.s = state;
    server = makeFakeApi();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    state = freshState();
    ref.s = state;
  });

  const makeCtx = (over: Partial<RunContext> = {}): RunContext => ({
    repoRoot: process.cwd(),
    mode: "postdeploy",
    flags: { "base-url": base, invite: state.invite },
    env: {} as NodeJS.ProcessEnv,
    runCommand: stubRunner,
    runtime: { extraSecrets: [] },
    ...over,
  });

  const run = (ctx: RunContext, checks?: CheckSpec[]) =>
    runGate({ mode: "postdeploy", ctx, checks: checks ?? checksForMode("postdeploy", ctx) });

  const noSecretsInReport = (report: unknown, ctx: RunContext) => {
    const serialized = JSON.stringify(report);
    for (const secret of ctx.runtime.extraSecrets) {
      expect(secret.length).toBeGreaterThan(4);
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(state.invite);
    expect(serialized).not.toContain("tok-");
  };

  it("happy path: bootstrap → authed status → smoke → cleanup; account deleted, session state cleaned", async () => {
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
    expect(ctx.runtime.session?.state).toBe("cleaned");
    expect([...state.accounts.values()][0]!.deleted).toBe(true);
    expect(state.sessions.size).toBe(0);
    noSecretsInReport(report, ctx);
  });

  it("mid-validation failure: status 503 → FAIL, smoke skipped, cleanup STILL deletes the account", async () => {
    state.statusMode = "error";
    const ctx = makeCtx();
    const report = await run(ctx);
    expect(report.outcome).toBe("FAIL");
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.ops_status_authed!.status).toBe("failed");
    expect(byId.smoke!.status).toBe("skipped");
    expect(byId.synthetic_session_cleanup!.status).toBe("passed");
    expect([...state.accounts.values()][0]!.deleted).toBe(true);
    noSecretsInReport(report, ctx);
  });

  it("login HTTP failure after signup: bootstrap FAILs but cleanup RECOVERS + deletes the account", async () => {
    state.loginMode = "reject-then-ok"; // 1st login (bootstrap) 401; later ok
    const ctx = makeCtx();
    const report = await run(ctx);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.synthetic_session_bootstrap!.status).toBe("failed");
    expect(byId.synthetic_session_cleanup!.status).toBe("passed"); // recovered
    expect(ctx.runtime.session?.state).toBe("cleaned");
    expect([...state.accounts.values()][0]!.deleted).toBe(true); // no orphan
    noSecretsInReport(report, ctx);
  });

  it("login NETWORK failure after signup: account recorded, cleanup recovers + deletes", async () => {
    state.loginMode = "reset"; // 1st login destroys the socket; later ok
    const ctx = makeCtx();
    const report = await run(ctx);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.synthetic_session_bootstrap!.status).toBe("failed");
    expect(byId.synthetic_session_cleanup!.status).toBe("passed");
    expect([...state.accounts.values()][0]!.deleted).toBe(true);
    noSecretsInReport(report, ctx);
  });

  it("unrecoverable cleanup: login can never succeed → FAIL loudly with a sanitized synthetic handle", async () => {
    state.loginMode = "reject"; // bootstrap AND every recovery login 401
    const ctx = makeCtx();
    const report = await run(ctx);
    const cleanup = report.checks.find((c) => c.id === "synthetic_session_cleanup")!;
    expect(cleanup.status).toBe("failed");
    expect(cleanup.summary).toContain("MANUAL cleanup required");
    expect(cleanup.summary).toContain("@nova-validate.invalid"); // the handle
    expect(ctx.runtime.session?.state).toBe("cleanup_failed");
    // The password is NEVER in the summary/report even on this failure path.
    noSecretsInReport(report, ctx);
    expect(cleanup.summary).not.toContain(ctx.runtime.session!.password);
  });

  it("delete rejected → cleanup FAILs (never silent) with a sanitized handle", async () => {
    state.deleteMode = "reject";
    const ctx = makeCtx();
    const report = await run(ctx);
    const cleanup = report.checks.find((c) => c.id === "synthetic_session_cleanup")!;
    expect(cleanup.status).toBe("failed");
    expect(cleanup.summary).toContain("MANUAL cleanup required");
    expect(cleanup.summary).toContain("@nova-validate.invalid");
    noSecretsInReport(report, ctx);
  });

  it("approach A: pre-supplied token is REVOKED and proven dead (no account created)", async () => {
    // Pre-mint an operator session directly.
    state.accounts.set("op@nova-validate.invalid", { password: "x", deleted: false });
    state.sessions.set("operator-token-1", "op@nova-validate.invalid");
    const ctx = makeCtx({
      env: { NOVA_VALIDATE_SESSION_TOKEN: "operator-token-1" } as NodeJS.ProcessEnv,
    });
    const report = await run(ctx);
    expect(report.outcome).toBe("PASS");
    const cleanup = report.checks.find((c) => c.id === "synthetic_session_cleanup")!;
    expect(cleanup.status).toBe("passed");
    expect(cleanup.summary).toContain("REVOKED");
    expect(state.revoked.has("operator-token-1")).toBe(true); // actually revoked
    expect(state.signups).toHaveLength(0); // no in-gate account
  });

  it("finding P1: approach-A logout that leaves the session live (probe 403) → cleanup FAILs, only 401 proves dead", async () => {
    // A broken logout: it 200s but does NOT revoke, and the session is still
    // authenticated (merely forbidden → 403). The OLD code treated 403 as dead
    // and falsely certified revocation; the fix requires a literal 401.
    state.accounts.set("op@nova-validate.invalid", { password: "x", deleted: false });
    state.sessions.set("operator-token-live", "op@nova-validate.invalid");
    state.logoutMode = "noop";
    state.statusMode = "forbidden";
    const ctx = makeCtx({
      env: { NOVA_VALIDATE_SESSION_TOKEN: "operator-token-live" } as NodeJS.ProcessEnv,
    });
    ctx.runtime.session = {
      state: "authenticated",
      email: "",
      password: "",
      token: "operator-token-live",
      bootstrapped: false,
    };
    const out = await syntheticSessionCleanup(ctx);
    expect(out.status).toBe("failed");
    expect(out.summary).toContain("only 401 proves a dead session");
    expect(out.summary).toContain("revoke it manually");
    expect(ctx.runtime.session.state).toBe("cleanup_failed");
    // The still-live token was NOT wrongly reported as revoked.
    expect(state.revoked.has("operator-token-live")).toBe(false);
  });

  it("finding P2: signup committed but the response was lost (HTTP 502) → cleanup RECOVERS the orphan and deletes it", async () => {
    state.signupMode = "commit-then-502"; // account IS created; caller sees 502
    const ctx = makeCtx();
    const report = await run(ctx);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.synthetic_session_bootstrap!.status).toBe("failed");
    // The account really exists — cleanup must re-login and delete it.
    expect(byId.synthetic_session_cleanup!.status).toBe("passed");
    expect(ctx.runtime.session?.state).toBe("cleaned");
    expect(state.signups).toHaveLength(1);
    expect([...state.accounts.values()][0]!.deleted).toBe(true); // no orphan left
    noSecretsInReport(report, ctx);
  });

  it("finding P2: signup truly failed (HTTP 500, no account) → cleanup passes 'likely no orphan' with a handle, deletes nothing", async () => {
    state.signupMode = "fail"; // 500, nothing created
    const ctx = makeCtx();
    const report = await run(ctx);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.synthetic_session_bootstrap!.status).toBe("failed");
    const cleanup = byId.synthetic_session_cleanup!;
    // No confirmed account → we cannot claim an orphan, but must not claim a
    // false "nothing to clean" either: PASS while emitting the handle.
    expect(cleanup.status).toBe("passed");
    expect(cleanup.summary).toContain("likely no orphan");
    expect(cleanup.summary).toContain("@nova-validate.invalid");
    expect(ctx.runtime.session?.state).toBe("cleaned");
    expect(state.signups).toHaveLength(0); // nothing was created
    noSecretsInReport(report, ctx);
  });

  it("finding P3: the invite is registered as a sanitizer secret (present in extraSecrets, absent from the report)", async () => {
    const ctx = makeCtx();
    const report = await run(ctx);
    expect(ctx.runtime.extraSecrets).toContain(state.invite);
    expect(JSON.stringify(report)).not.toContain(state.invite);
  });

  it("rerun is idempotent: each run mints a unique account and cleans it up", async () => {
    await run(makeCtx());
    const first = [...state.signups];
    await run(makeCtx());
    expect(state.signups).toHaveLength(2);
    expect(new Set(state.signups).size).toBe(2);
    expect(first[0]).not.toBe(state.signups[1]);
    expect([...state.accounts.values()].every((a) => a.deleted)).toBe(true);
  });

  it("cleanup with no session (bootstrap never created anything) passes with nothing to clean", async () => {
    const ctx = makeCtx();
    const out = await syntheticSessionCleanup(ctx); // session undefined
    expect(out.status).toBe("passed");
    expect(out.summary).toContain("nothing to clean");
  });
});
