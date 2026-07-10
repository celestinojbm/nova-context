import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SessionExpiredError,
  claimPairingCode,
  postMoment,
  revokeSession,
  type ShellSettings,
} from "../src/api-client.js";
import { toCreateMomentRequest, type ShellPageContext } from "../src/capture.js";

const PAGE: ShellPageContext = {
  title: "T",
  url: "https://example.com/",
  main_text: "body",
  selected_text: null,
  meta_description: "",
  headings: [],
  viewport: { w: 100, h: 100 },
};

const SETTINGS: ShellSettings = {
  ...DEFAULT_SETTINGS,
  deviceToken: "nova_sess_test_token",
  accountEmail: "a@b.c",
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("postMoment", () => {
  it("sends Bearer auth + strict_image_redaction to the moments endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "m1" }));
    const body = toCreateMomentRequest({ page: PAGE, screenshotDataUrl: null }, "hi", null);
    const res = await postMoment(
      { ...SETTINGS, strictRedaction: true },
      body,
      fetchImpl,
    );
    expect(res).toEqual({ id: "m1" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/v1/context/moments");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer nova_sess_test_token",
    );
    const sent = JSON.parse(init.body as string);
    expect(sent.strict_image_redaction).toBe(true);
    expect(sent.source_meta.app).toBe("nova-browser-shell");
  });

  it("fails closed without a token — no network call is made", async () => {
    const fetchImpl = vi.fn();
    await expect(
      postMoment({ ...SETTINGS, deviceToken: "" }, {} as never, fetchImpl),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401 to SessionExpiredError so the caller clears the token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    await expect(postMoment(SETTINGS, {} as never, fetchImpl)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("surfaces other API errors with truncated detail", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("x".repeat(1000), { status: 500 }));
    await expect(postMoment(SETTINGS, {} as never, fetchImpl)).rejects.toThrow(
      /^API 500: x{300}$/,
    );
  });
});

describe("claimPairingCode", () => {
  it("exchanges a code for a device session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, { token: "tok", user: { email: "u@e.x" } }),
    );
    const out = await claimPairingCode("http://api", "  code-1  ", fetchImpl);
    expect(out).toEqual({ token: "tok", email: "u@e.x" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api/v1/auth/pairing/claim");
    expect(JSON.parse(init.body as string)).toEqual({ code: "code-1" });
  });

  it("maps 401 and 429 to actionable messages", async () => {
    const unauth = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    await expect(claimPairingCode("http://api", "c", unauth)).rejects.toThrow(
      /invalid or expired/,
    );
    const limited = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    await expect(claimPairingCode("http://api", "c", limited)).rejects.toThrow(
      /Too many attempts/,
    );
  });
});

describe("revokeSession", () => {
  it("revokes server-side and never throws on network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(revokeSession(SETTINGS, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("is a no-op without a token", async () => {
    const fetchImpl = vi.fn();
    await revokeSession({ ...SETTINGS, deviceToken: "" }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
