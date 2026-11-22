import { describe, expect, it } from "vitest";
import { extractFacts } from "./fact-extractor.js";
import { filterSkippedPii } from "./write-facts.js";

const facts = (t: string) => extractFacts(filterSkippedPii(t)).map((f) => f.content);

describe("M20a — PII filter for redaction 'skipped'", () => {
  it("drops sentences with emails", () => {
    expect(facts("El correo de Ana es ana.perez@example.com. Ana vive en Quito.")).toEqual(["Ana vive en Quito"]);
  });
  it("drops sentences with phone numbers", () => {
    expect(facts("Su teléfono es +34 612 345 678. Pedro trabaja en Bilbao.")).toEqual(["Pedro trabaja en Bilbao"]);
  });
  it("drops sentences with Luhn-valid cards", () => {
    expect(facts("La tarjeta es 4111 1111 1111 1111. El plan Pro cuesta 49 USD.")).toEqual(["El plan Pro cuesta 49 USD"]);
  });
  it("never leaks the raw value", () => {
    const out = JSON.stringify(extractFacts(filterSkippedPii("Mi email es x@y.io y vive en Lima.")));
    expect(out).not.toContain("x@y.io");
  });
  it("keeps clean text and nulls unchanged", () => {
    expect(facts("Lucía vive en Valencia.")).toEqual(["Lucía vive en Valencia"]);
    expect(filterSkippedPii(null)).toBeNull();
  });
});
