/**
 * M20b: Markdown export of one memory namespace in the `nova-memory-md/v1`
 * format (docs/design/memoria-m20.md §2.3). Pure: callers pass rows that were
 * ALREADY filtered (local_only excluded, user-scoped). No media, ids in HTML
 * comments for re-import, ordered by date.
 */
export const MARKDOWN_FORMAT = "nova-memory-md/v1";

export interface ExportItem {
  id: string;
  content: string;
  status: "active" | "merged" | "superseded" | "contested";
  author: string;
  valid_from: Date | null;
  created_at: Date;
  sources: string[]; // moment ids
}

function day(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "unknown";
}

/** One line: no newlines, no HTML comment breakers. Content is never raw media. */
export function inline(text: string): string {
  return text.replace(/\s+/g, " ").replace(/-->/g, "-- >").replace(/<!--/g, "< !--").trim();
}

export function renderNamespaceMarkdown(
  slug: string,
  items: ExportItem[],
  exportedAt: Date = new Date(),
): string {
  const sorted = [...items].sort(
    (a, b) =>
      (a.valid_from ?? a.created_at).getTime() - (b.valid_from ?? b.created_at).getTime() ||
      a.id.localeCompare(b.id),
  );
  const active = sorted.filter((i) => i.status === "active");
  const superseded = sorted.filter((i) => i.status === "superseded" || i.status === "merged");
  const contested = sorted.filter((i) => i.status === "contested");
  const out: string[] = [
    "---",
    `namespace: ${slug}`,
    `exported_at: ${exportedAt.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    `items: ${sorted.length}`,
    `format: ${MARKDOWN_FORMAT}`,
    "---",
    `# ${slug}`,
    "",
    "## Hechos activos",
  ];
  for (const i of active) {
    out.push(`- ${inline(i.content)} <!-- id:${i.id} valid_from:${day(i.valid_from)} author:${i.author} -->`);
    if (i.sources.length) {
      out.push(
        `  - Fuentes: ${i.sources.map((m) => `[momento ${m.slice(0, 8)}](nova://moment/${m})`).join(", ")}`,
      );
    }
  }
  out.push("", "## Reemplazados");
  for (const i of superseded) {
    out.push(`- ~~${inline(i.content)}~~ (${day(i.valid_from)}) <!-- id:${i.id} status:${i.status} author:${i.author} -->`);
  }
  out.push("", "## En conflicto (pendiente de revisar)");
  for (const i of contested) {
    out.push(`- «${inline(i.content)}» — capturado ${day(i.valid_from)} <!-- id:${i.id} author:${i.author} -->`);
  }
  return out.join("\n") + "\n";
}
