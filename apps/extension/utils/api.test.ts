import { describe, expect, it } from "vitest";
import { DEFAULT_EXTENSION_SETTINGS } from "./api";

/**
 * M15B (Hermes D06): a fresh extension install must default to STRICT
 * redaction — never unsafe retention. (An old/inherited setting that sends
 * strict_image_redaction:false is separately overridden server-side in
 * production; see services/api alpha-blockers.test.ts.)
 */
describe("extension default settings", () => {
  it("defaults strictRedaction to true", () => {
    expect(DEFAULT_EXTENSION_SETTINGS.strictRedaction).toBe(true);
  });
});
