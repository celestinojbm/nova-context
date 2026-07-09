import { describe, expect, it } from "vitest";
import { redactDeep, redactText } from "./redaction.js";

describe("redactText", () => {
  it.each([
    ["contact me at jane.doe+work@example.com please", "email"],
    ["call (415) 555-0134 tomorrow", "phone"],
    ["intl: +44 20 7946 0958", "phone"],
    ["card: 4111 1111 1111 1111 exp 12/28", "card"],
    ["ssn is 078-05-1120 on file", "ssn"],
    ["OPENAI key sk-proj0123456789abcdef0123", "api_key"],
    ["token ghp_abcdefghij0123456789KLMNOPQRST", "api_key"],
    ["aws AKIAIOSFODNN7EXAMPLE in config", "api_key"],
    ["slack xoxb-123456789-abcdefghij", "api_key"],
    ["api_key: 0123456789abcdef0123456789abcdef", "api_key"],
    ["DE89 3704 0044 0532 0130 00 is the IBAN", "iban"],
  ])("redacts %s", (input, type) => {
    const result = redactText(input);
    expect(result.text).toContain(`[REDACTED:${type}]`);
    expect(result.total).toBeGreaterThan(0);
  });

  it("removes the sensitive value itself", () => {
    const result = redactText("email jane@example.com card 4111-1111-1111-1111");
    expect(result.text).not.toContain("jane@example.com");
    expect(result.text).not.toContain("4111");
  });

  it("does not redact ordinary numbers (Luhn guard)", () => {
    // 16 digits failing Luhn: an order number, not a card.
    const result = redactText("order 1234 5678 9012 3457 shipped, qty 30, $99");
    expect(result.text).toContain("1234 5678 9012 3457");
    expect(result.hits.find((h) => h.type === "card")).toBeUndefined();
  });

  it("does not redact prices, years, or short digit runs", () => {
    const text = "Enterprise plans start at $99 per month since 2024, v3.15.0";
    expect(redactText(text).text).toBe(text);
  });

  it("counts multiple hits per type", () => {
    const result = redactText("a@b.co and c@d.org");
    expect(result.hits).toEqual([{ type: "email", count: 2 }]);
  });
});

describe("redactDeep", () => {
  it("redacts nested payload fields and arrays, tallying hits", () => {
    const tally = new Map();
    const out = redactDeep(
      {
        dom_extract: {
          main_text: "reach me at leak@example.com",
          headings: ["Contact: другой@пример.com", "Call (415) 555-0134"],
        },
        count: 3,
      },
      tally,
    );
    expect(JSON.stringify(out)).not.toContain("leak@example.com");
    expect(out.dom_extract.headings[1]).toContain("[REDACTED:phone]");
    expect(out.count).toBe(3);
    expect(tally.get("email")).toBeGreaterThanOrEqual(1);
  });

  it("leaves data: URLs (screenshots) untouched", () => {
    const dataUrl = "data:image/jpeg;base64,QUJDMTIzNDU2Nzg5";
    const out = redactDeep({ screenshot_data_url: dataUrl });
    expect(out.screenshot_data_url).toBe(dataUrl);
  });
});
