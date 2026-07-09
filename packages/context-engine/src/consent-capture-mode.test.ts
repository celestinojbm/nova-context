import { describe, expect, it } from "vitest";
import { applyCaptureMode, framesAllowed } from "./capture-mode.js";
import { CONSENT_POINTS, CONSENT_VERSION, consentValid, makeConsent } from "./consent.js";

describe("consent gate", () => {
  it("requires consent before capture (no record = invalid)", () => {
    expect(consentValid(null)).toBe(false);
    expect(consentValid(undefined)).toBe(false);
  });

  it("accepts a current consent record", () => {
    expect(consentValid(makeConsent())).toBe(true);
  });

  it("invalidates consent after a version bump (re-onboarding)", () => {
    const old = { version: CONSENT_VERSION, accepted_at: new Date().toISOString() };
    expect(consentValid(old, CONSENT_VERSION + 1)).toBe(false);
  });

  it("reset semantics: removing the record re-blocks capture", () => {
    let record: ReturnType<typeof makeConsent> | null = makeConsent();
    expect(consentValid(record)).toBe(true);
    record = null; // resetConsent() removes storage
    expect(consentValid(record)).toBe(false);
  });

  it("rejects malformed records", () => {
    expect(consentValid({ version: 1, accepted_at: "not a date" })).toBe(false);
    // @ts-expect-error deliberately malformed
    expect(consentValid({ accepted_at: new Date().toISOString() })).toBe(false);
  });

  it("disclosures cover the required ground", () => {
    const text = CONSENT_POINTS.map((p) => `${p.title} ${p.body}`).join(" ");
    for (const needle of [
      "no silent capture",
      "Instant Capture",
      "Live Context",
      "destroyed when the session ends",
      "cloud providers",
      "pixels inside screenshots",
    ]) {
      expect(text.toLowerCase()).toContain(needle.toLowerCase());
    }
  });
});

describe("capture modes (visual-redaction safeguards)", () => {
  const payload = {
    dom_extract: { main_text: "visible text" },
    screenshot_data_url: "data:image/jpeg;base64,AAAA",
    nested: { thumb: "data:image/png;base64,BBBB", note: "keep me" },
  };

  it("text_only strips every image payload, at any depth", () => {
    const out = applyCaptureMode(payload, "text_only");
    expect(JSON.stringify(out)).not.toContain("data:image");
    expect(out.dom_extract.main_text).toBe("visible text");
    expect((out.nested as Record<string, unknown>).note).toBe("keep me");
    expect("screenshot_data_url" in out).toBe(false);
  });

  it("full and blurred modes keep the (already-processed) image", () => {
    expect(applyCaptureMode(payload, "full").screenshot_data_url).toBeTruthy();
    expect(applyCaptureMode(payload, "blurred").screenshot_data_url).toBeTruthy();
  });

  it("frames are disallowed in live sessions under text_only", () => {
    expect(framesAllowed("text_only")).toBe(false);
    expect(framesAllowed("full")).toBe(true);
    expect(framesAllowed("blurred")).toBe(true);
  });
});
