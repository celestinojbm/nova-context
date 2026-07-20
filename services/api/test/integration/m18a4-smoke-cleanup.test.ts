import { describe, expect, it } from "vitest";
import { runSmoke, type SmokeStep } from "../../src/ops/smoke.js";

/**
 * M18A.4 P1-2 (NCA-17-002): ops:smoke's synthetic account has a failure-safe,
 * PROVABLE lifecycle. These tests drive `runSmoke` with an injected fetch (its
 * designed seam) to exercise the whole cleanup matrix deterministically:
 * cleanup ALWAYS runs, HTTP 200 from delete is never proof on its own, and the
 * account is reported clean ONLY when both the token probe AND a credential
 * re-login return exactly HTTP 401. The real happy path + real dead-account
 * proof are covered separately by smoke.test.ts (real app) and the M18A.3 E2E.
 */

const SMOKE_TOKEN = "SMOKETOKENxyz";
const INVITE = "invite-secret-code-xyz";

type Resp = { status: number; body?: unknown };

interface FakeCfg {
  readyz?: number;
  signup?: () => number; // may throw to simulate a lost response
  login?: (call: number) => number; // call 1 = initial; later = recover/relogin
  deleteStatus?: (attempt: number) => number; // return 0 to simulate a network throw
  probe?: () => number; // GET /v1/ops/status after delete
  throwOn?: (path: string, method: string) => boolean;
  productDefault?: number;
}

function makeFetch(cfg: FakeCfg): typeof fetch {
  let loginN = 0;
  let deleteN = 0;
  const respond = (status: number, body: unknown = {}) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as unknown as Response;
  return (async (rawUrl: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof rawUrl === "string" ? rawUrl : rawUrl.toString());
    const path = url.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    if (cfg.throwOn?.(path, method)) throw new Error("ECONNRESET simulated network failure");
    if (path === "/readyz") return respond(cfg.readyz ?? 200, { ready: true });
    if (path === "/v1/auth/signup" && method === "POST") {
      const s = cfg.signup ? cfg.signup() : 201;
      return respond(s, s === 201 ? {} : { error: "x" });
    }
    if (path === "/v1/auth/login" && method === "POST") {
      loginN += 1;
      const s = cfg.login ? cfg.login(loginN) : 200;
      return respond(s, s === 200 ? { token: SMOKE_TOKEN } : {});
    }
    if (path === "/v1/auth/account/delete" && method === "POST") {
      deleteN += 1;
      const s = cfg.deleteStatus ? cfg.deleteStatus(deleteN) : 200;
      if (s === 0) throw new Error("ECONNRESET simulated network failure");
      return respond(s, {});
    }
    if (path === "/v1/ops/status") {
      return respond(cfg.probe ? cfg.probe() : 401, {});
    }
    return respond(cfg.productDefault ?? 500, {});
  }) as unknown as typeof fetch;
}

const stepOf = (steps: SmokeStep[], name: string) => steps.find((s) => s.step === name);
/** Standard config: signup 201, login OK once, then short-circuit the product
 * walk with a throw at the first post-login call so cleanup runs immediately. */
const reachCleanup = (over: FakeCfg): FakeCfg => ({
  signup: () => 201,
  login: (n) => (n === 1 ? 200 : 401),
  throwOn: (p) => p === "/v1/auth/pairing-codes",
  ...over,
});

async function run(cfg: FakeCfg) {
  return runSmoke("http://fake.local", { inviteCode: INVITE, enrichmentWaitMs: 0 }, makeFetch(cfg));
}

describe("M18A.4 P1-2: ops:smoke failure-safe provable cleanup", () => {
  it("signup 5xx after possible commit → recover + delete + prove dead (account_delete ok)", async () => {
    // login #1 = recover (account committed → 200); login #2 = post-delete relogin (gone → 401).
    const { steps } = await run(reachCleanup({ signup: () => 500, deleteStatus: () => 200, probe: () => 401 }));
    // signup failed, but cleanup RECOVERED the possibly-committed account and proved it dead.
    expect(stepOf(steps, "signup")?.status).toBe("fail");
    expect(stepOf(steps, "account_delete")?.status).toBe("ok");
  });

  it("signup commit with response lost (throws) → recovered + proven dead", async () => {
    const { steps } = await run(
      reachCleanup({
        signup: () => {
          throw new Error("socket hang up");
        },
        deleteStatus: () => 200,
        probe: () => 401,
      }),
    );
    expect(stepOf(steps, "signup")?.status).toBe("fail");
    expect(stepOf(steps, "account_delete")?.status).toBe("ok");
  });

  it("login 401 → unrecoverable → cleanup FAIL (never 'likely clean')", async () => {
    const { ok, steps } = await run(reachCleanup({ login: () => 401 }));
    expect(stepOf(steps, "login")?.status).toBe("fail");
    expect(stepOf(steps, "account_delete")?.status).toBe("fail");
    expect(stepOf(steps, "account_delete")?.detail).toContain("MANUAL");
    expect(ok).toBe(false);
  });

  it("login network failure → unrecoverable → cleanup FAIL", async () => {
    const { steps } = await run(
      reachCleanup({ login: () => 200, throwOn: (p) => p === "/v1/auth/login" }),
    );
    expect(stepOf(steps, "account_delete")?.status).toBe("fail");
  });

  it("exception halfway through smoke → cleanup still runs and proves dead", async () => {
    const { steps } = await run(
      reachCleanup({ throwOn: (p) => p === "/v1/auth/pairing-codes", deleteStatus: () => 200, probe: () => 401 }),
    );
    expect(stepOf(steps, "smoke_exception")?.status).toBe("fail");
    expect(stepOf(steps, "account_delete")?.status).toBe("ok"); // cleanup ran + proved dead
  });

  it("delete 5xx → cleanup FAIL with a sanitized manual handle", async () => {
    const { steps } = await run(reachCleanup({ deleteStatus: () => 500 }));
    const d = stepOf(steps, "account_delete");
    expect(d?.status).toBe("fail");
    expect(d?.detail).toContain("MANUAL");
  });

  it("delete 200 but account still authenticates (token probe 200) → NOT proven → FAIL", async () => {
    const { steps } = await run(
      reachCleanup({ deleteStatus: () => 200, probe: () => 200, login: (n) => (n === 1 ? 200 : 401) }),
    );
    const d = stepOf(steps, "account_delete");
    expect(d?.status).toBe("fail");
    expect(d?.detail).toContain("token probe HTTP 200");
  });

  it("delete 200 but credentials still log in (relogin 200) → NOT proven → FAIL", async () => {
    const { steps } = await run(
      reachCleanup({ deleteStatus: () => 200, probe: () => 401, login: () => 200 }),
    );
    const d = stepOf(steps, "account_delete");
    expect(d?.status).toBe("fail");
    expect(d?.detail).toContain("relogin HTTP 200");
  });

  it("post-delete proof timeout (probe unreachable) → NOT proven → FAIL", async () => {
    const { steps } = await run(
      reachCleanup({
        deleteStatus: () => 200,
        login: (n) => (n === 1 ? 200 : 401),
        throwOn: (p) => p === "/v1/auth/pairing-codes" || p === "/v1/ops/status",
      }),
    );
    const d = stepOf(steps, "account_delete");
    expect(d?.status).toBe("fail");
    expect(d?.detail).toContain("token probe HTTP unreachable");
  });

  it("post-delete proof 401 (token + creds) → PASS (account_delete ok)", async () => {
    const { steps } = await run(
      reachCleanup({ deleteStatus: () => 200, probe: () => 401, login: (n) => (n === 1 ? 200 : 401) }),
    );
    expect(stepOf(steps, "account_delete")?.status).toBe("ok");
  });

  it("cleanup retry success: delete throws twice then 200, proven dead → ok", async () => {
    const { steps } = await run(
      reachCleanup({
        deleteStatus: (attempt) => (attempt < 3 ? 0 : 200), // 0 → simulated network throw
        probe: () => 401,
        login: (n) => (n === 1 ? 200 : 401),
      }),
    );
    expect(stepOf(steps, "account_delete")?.status).toBe("ok");
  });

  it("readyz fail before any account → nothing to clean (account_delete ok, no orphan)", async () => {
    const { steps } = await run({ readyz: 503 });
    expect(stepOf(steps, "readyz")?.status).toBe("fail");
    expect(stepOf(steps, "account_delete")?.status).toBe("ok");
    expect(stepOf(steps, "account_delete")?.detail).toContain("nothing to clean");
  });

  it("no password, token, or invite ever appears in the reported steps", async () => {
    const { steps } = await run(
      reachCleanup({ deleteStatus: () => 200, probe: () => 200, login: (n) => (n === 1 ? 200 : 401) }),
    );
    const blob = JSON.stringify(steps);
    expect(blob).not.toContain(SMOKE_TOKEN);
    expect(blob).not.toContain(INVITE);
    expect(blob).not.toMatch(/smoke-smokealpha[a-z]+-pass/); // the synthetic password shape
  });
});
