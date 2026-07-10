import { describe, expect, it } from "vitest";
import {
  buildNotionDatabaseProperties,
  validateNotionMapping,
} from "./notion-mapping.js";

const DB_PROPS = [
  { name: "Name", type: "title" },
  { name: "Summary", type: "rich_text" },
  { name: "Link", type: "url" },
  { name: "Tags", type: "multi_select" },
  { name: "Priority", type: "select" },
  { name: "Captured", type: "date" },
  { name: "Status", type: "status" },
];

describe("validateNotionMapping", () => {
  it("accepts a fully compatible mapping", () => {
    expect(
      validateNotionMapping(
        {
          title: "Name",
          summary: "Summary",
          source_url: "Link",
          tags: "Tags",
          priority: "Priority",
          created: "Captured",
          moment_ref: "Summary",
        },
        DB_PROPS,
      ),
    ).toEqual([]);
  });

  it("flags missing properties and incompatible types, skips nulls", () => {
    const issues = validateNotionMapping(
      { title: "Name", summary: "Status", tags: "Nope", priority: null },
      DB_PROPS,
    );
    expect(issues).toHaveLength(2);
    expect(issues).toContainEqual({
      field: "summary",
      property: "Status",
      problem: "incompatible_type",
      found: "status",
    });
    expect(issues).toContainEqual({
      field: "tags",
      property: "Nope",
      problem: "missing_property",
    });
  });
});

describe("buildNotionDatabaseProperties", () => {
  const types = new Map(DB_PROPS.map((p) => [p.name, p.type]));
  const values = {
    title: "A page",
    summary: "What it is",
    sourceUrl: "https://example.com/x",
    tags: ["alpha", "beta"],
    priority: "high",
    capturedAt: "2026-07-09T00:00:00.000Z",
    momentId: "moment-1",
  };

  it("builds typed properties for every mapped field", () => {
    const props = buildNotionDatabaseProperties(
      {
        title: "Name",
        summary: "Summary",
        source_url: "Link",
        tags: "Tags",
        priority: "Priority",
        created: "Captured",
        moment_ref: "Summary2",
      },
      values,
      new Map([...types, ["Summary2", "rich_text"]]),
    );
    expect(props["Name"]).toEqual({
      title: [{ type: "text", text: { content: "A page" } }],
    });
    expect(props["Link"]).toEqual({ url: "https://example.com/x" });
    expect(props["Tags"]).toEqual({
      multi_select: [{ name: "alpha" }, { name: "beta" }],
    });
    expect(props["Priority"]).toEqual({ select: { name: "high" } });
    expect(props["Captured"]).toEqual({ date: { start: values.capturedAt } });
    expect(props["Summary2"]).toEqual({
      rich_text: [{ type: "text", text: { content: "Nova moment moment-1" } }],
    });
  });

  it("omits unmapped fields and missing values; title is always present", () => {
    const props = buildNotionDatabaseProperties(
      { title: "Name", summary: "Summary" },
      { ...values, summary: null },
      types,
    );
    expect(Object.keys(props)).toEqual(["Name"]);
  });

  it("degrades url-typed fields to rich_text when the property is textual", () => {
    const props = buildNotionDatabaseProperties(
      { title: "Name", source_url: "Summary" },
      values,
      types,
    );
    expect(props["Summary"]).toEqual({
      rich_text: [{ type: "text", text: { content: "https://example.com/x" } }],
    });
  });
});
