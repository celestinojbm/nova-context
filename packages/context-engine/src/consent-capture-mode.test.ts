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

  // M16 (Hermes M15C accepted-P3): text_only must recurse into ARRAYS and
  // catch mixed-case inline images too — not just top-level/object fields.
  it("text_only strips inline images inside arrays (incl. mixed case)", () => {
    const withArrays = {
      live_session: {
        frames: [
          "DATA:image/jpeg;base64,AAAA",
          "keep-this-text",
          "data:image/png;base64,BBBB",
        ],
        qa: [{ question: "q", frame: "Data:Image/png;base64,CCCC" }],
      },
      tags: ["a", "b"],
    };
    const out = applyCaptureMode(withArrays, "text_only");
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/data:image/i); // no case variant survives
    expect(s).toContain("keep-this-text"); // non-image array items survive
    expect(s).toContain("\"a\""); // unrelated arrays untouched
    const frames = (out.live_session as { frames: unknown[] }).frames;
    expect(frames).toEqual(["keep-this-text"]);
    const qa = (out.live_session as { qa: Array<Record<string, unknown>> }).qa;
    expect(qa[0].frame).toBeUndefined();
    expect(qa[0].question).toBe("q");
  });

  it("frames are disallowed in live sessions under text_only", () => {
    expect(framesAllowed("text_only")).toBe(false);
    expect(framesAllowed("full")).toBe(true);
    expect(framesAllowed("blurred")).toBe(true);
  });
});
