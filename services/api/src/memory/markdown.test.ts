import { describe, expect, it } from "vitest";
import { inline, MARKDOWN_FORMAT, renderNamespaceMarkdown } from "./markdown.js";
import { isNamespaceToken, newNamespaceToken, tokenRouteAllowed } from "./tokens.js";
import { validSlug } from "../routes-namespaces.js";

const base = { author: "model", sources: [] as string[], created_at: new Date("2026-10-01T00:00:00Z") };

describe("M20b nova-memory-md/v1", () => {
  it("renders frontmatter, sections and ids in HTML comments, ordered by date", () => {
    const md = renderNamespaceMarkdown(
      "proyecto/demo",
      [
        { ...base, id: "b", content: "La demo es el 6-nov", status: "active", valid_from: new Date("2026-10-20T00:00:00Z"), sources: ["11111111-2222-3333-4444-555555555555"] },
        { ...base, id: "a", content: "Prefiere asientos de pasillo", status: "active", valid_from: new Date("2026-03-02T00:00:00Z") },
        { ...base, id: "c", content: "La demo es el 30-oct", status: "superseded", valid_from: new Date("2026-10-01T00:00:00Z") },
        { ...base, id: "d", content: "Precio 49 $", status: "contested", valid_from: null },
      ],
      new Date("2026-10-22T11:00:00.123Z"),
    );
    expect(md.startsWith("---\nnamespace: proyecto/demo\nexported_at: 2026-10-22T11:00:00Z\nitems: 4\nformat: nova-memory-md/v1\n---\n# proyecto/demo\n")).toBe(true);
    expect(md.indexOf("Prefiere asientos")).toBeLessThan(md.indexOf("6-nov"));
    expect(md).toContain("<!-- id:a valid_from:2026-03-02 author:model -->");
    expect(md).toContain("(nova://moment/11111111-2222-3333-4444-555555555555)");
    expect(md).toContain("~~La demo es el 30-oct~~");
    expect(md).toContain("«Precio 49 $»");
    expect(MARKDOWN_FORMAT).toBe("nova-memory-md/v1");
  });

  it("cannot break out of the id comment or inject lines", () => {
    expect(inline("x --> <!-- y\n# h")).toBe("x -- > < !-- y # h");
  });
});

describe("M20b tokens", () => {
  it("issues nvx_ tokens with an 8-char prefix", () => {
    const { token, prefix } = newNamespaceToken();
    expect(isNamespaceToken(token)).toBe(true);
    expect(prefix).toBe(token.slice(0, 8));
    expect(token.length).toBeGreaterThan(40);
  });

  it("only memory/export routes are reachable with a token", () => {
    expect(tokenRouteAllowed("GET", "/v1/namespaces/asistente/claude/memory")).toBe(true);
    expect(tokenRouteAllowed("POST", "/v1/namespaces/default/memory")).toBe(true);
    expect(tokenRouteAllowed("GET", "/v1/export/namespace/default.md")).toBe(true);
    expect(tokenRouteAllowed("GET", "/v1/namespaces")).toBe(false);
    expect(tokenRouteAllowed("POST", "/v1/namespace-tokens")).toBe(false);
    expect(tokenRouteAllowed("DELETE", "/v1/namespaces/default/memory")).toBe(false);
    expect(tokenRouteAllowed("GET", "/v1/context/moments")).toBe(false);
    expect(tokenRouteAllowed("GET", "/v1/projects")).toBe(false);
  });

  it("validates slugs", () => {
    expect(validSlug("asistente/claude")).toBe(true);
    expect(validSlug("a/memory")).toBe(false);
    expect(validSlug("../x")).toBe(false);
    expect(validSlug("UPPER")).toBe(false);
  });
});
