import {
  NOTION_MAPPING_COMPATIBILITY,
  type NotionDatabaseProperty,
  type NotionPropertyMapping,
} from "@nova/schema";

/**
 * M9: Notion database property mapping. ONE validator and ONE property
 * builder shared by the API (save-time validation + preview) and the
 * worker (execution) — the mapping the user approved is exactly the one
 * that executes.
 */

export interface NotionMappingIssue {
  field: keyof NotionPropertyMapping;
  property: string;
  problem: "missing_property" | "incompatible_type";
  /** Property type actually found (for incompatible_type). */
  found?: string;
}

/** Check every mapped Nova field against the database's live properties. */
export function validateNotionMapping(
  mapping: NotionPropertyMapping,
  properties: NotionDatabaseProperty[],
): NotionMappingIssue[] {
  const byName = new Map(properties.map((p) => [p.name, p.type]));
  const issues: NotionMappingIssue[] = [];
  for (const [field, propertyName] of Object.entries(mapping)) {
    if (propertyName == null) continue;
    const key = field as keyof NotionPropertyMapping;
    const type = byName.get(propertyName);
    if (type === undefined) {
      issues.push({ field: key, property: propertyName, problem: "missing_property" });
      continue;
    }
    const compatible = NOTION_MAPPING_COMPATIBILITY[key] ?? [];
    if (!compatible.includes(type)) {
      issues.push({
        field: key,
        property: propertyName,
        problem: "incompatible_type",
        found: type,
      });
    }
  }
  return issues;
}

export interface NotionMappingValues {
  title: string;
  summary: string | null;
  sourceUrl: string | null;
  tags: string[];
  priority: string | null;
  capturedAt: string | null; // ISO timestamp
  momentId: string | null;
}

/**
 * Build the Notion `properties` object for a create-page call against a
 * database parent. Fields without a mapping or without a value are simply
 * omitted; the title property is always present.
 */
export function buildNotionDatabaseProperties(
  mapping: NotionPropertyMapping,
  values: NotionMappingValues,
  propertyTypes: Map<string, string>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [mapping.title]: {
      title: [{ type: "text", text: { content: values.title.slice(0, 200) } }],
    },
  };
  const richText = (content: string) => ({
    rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }],
  });
  const put = (name: string | null | undefined, value: unknown) => {
    if (name && value !== null) props[name] = value;
  };

  if (mapping.summary && values.summary) put(mapping.summary, richText(values.summary));
  if (mapping.source_url && values.sourceUrl) {
    put(
      mapping.source_url,
      propertyTypes.get(mapping.source_url) === "url"
        ? { url: values.sourceUrl }
        : richText(values.sourceUrl),
    );
  }
  if (mapping.tags && values.tags.length) {
    put(mapping.tags, {
      multi_select: values.tags.slice(0, 20).map((t) => ({ name: t.slice(0, 100) })),
    });
  }
  if (mapping.priority && values.priority) {
    put(
      mapping.priority,
      propertyTypes.get(mapping.priority) === "select"
        ? { select: { name: values.priority.slice(0, 100) } }
        : richText(values.priority),
    );
  }
  if (mapping.created && values.capturedAt) {
    put(mapping.created, { date: { start: values.capturedAt } });
  }
  if (mapping.moment_ref && values.momentId) {
    put(
      mapping.moment_ref,
      propertyTypes.get(mapping.moment_ref) === "url"
        ? { url: `nova://moments/${values.momentId}` }
        : richText(`Nova moment ${values.momentId}`),
    );
  }
  return props;
}
