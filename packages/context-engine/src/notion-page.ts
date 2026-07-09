/**
 * Notion page composition (M6, hardened in M7). ONE builder produces both
 * the preview the user approves and the content the worker actually writes —
 * what you see on the approval card is what lands in Notion. Captured
 * content stays data: nothing here is interpreted, only quoted. Screenshots
 * are NEVER included: Notion embeds need a public URL and Nova does not host
 * captured pixels — the privacy note says exactly that.
 */

export interface NotionPageSource {
  momentId: string | null;
  momentTitle: string | null;
  momentSummary: string | null;
  sourceUrl: string | null;
  capturedAt: string | null; // ISO timestamp
  extractedText: string | null;
  instruction: string | null; // the user's own words at capture time
  tags: string[];
  /** M7: provenance + privacy metadata. */
  actionId?: string | null;
  textRedaction?: string | null; // 'applied' | 'skipped' | ...
  imageRedaction?: string | null; // report state
  imageMaskedRegions?: number;
}

export interface NotionPageSection {
  heading: string | null;
  text: string;
}

export interface NotionPageContent {
  title: string;
  sections: NotionPageSection[];
}

const EXCERPT_MAX = 600;

export function buildNotionPageContent(
  payload: { title: string; detail?: string | null },
  source: NotionPageSource,
): NotionPageContent {
  const sections: NotionPageSection[] = [];

  const summary = source.momentSummary ?? payload.detail ?? null;
  if (summary) sections.push({ heading: "Summary", text: summary });

  if (source.instruction) {
    sections.push({ heading: "Your instruction", text: source.instruction });
  }

  const sourceParts: string[] = [];
  if (source.momentTitle) sourceParts.push(source.momentTitle);
  if (source.sourceUrl) sourceParts.push(source.sourceUrl);
  if (source.capturedAt) sourceParts.push(`captured ${source.capturedAt}`);
  if (sourceParts.length) {
    sections.push({ heading: "Source", text: sourceParts.join(" — ") });
  }

  if (source.extractedText?.trim()) {
    const excerpt = source.extractedText.trim().slice(0, EXCERPT_MAX);
    sections.push({
      heading: "Captured text (excerpt)",
      text: excerpt + (source.extractedText.trim().length > EXCERPT_MAX ? "…" : ""),
    });
  }

  if (source.tags.length) {
    sections.push({ heading: "Tags", text: source.tags.join(", ") });
  }

  // M7 privacy note: redaction provenance, and the explicit no-screenshot
  // policy — so the Notion page itself explains what was withheld.
  const privacy: string[] = [];
  privacy.push(
    `Text redaction: ${source.textRedaction ?? "unknown"}.`,
    `Image redaction: ${source.imageRedaction ?? "none"}${
      source.imageMaskedRegions ? ` (${source.imageMaskedRegions} region(s) masked)` : ""
    }.`,
    "Screenshots are not uploaded to Notion.",
  );
  sections.push({ heading: "Privacy", text: privacy.join(" ") });

  const refs: string[] = [];
  if (source.momentId) refs.push(`Nova Context moment ${source.momentId}`);
  if (source.actionId) refs.push(`action ${source.actionId} (see your Nova audit log)`);
  sections.push({
    heading: null,
    text: `Created by Nova Context${refs.length ? ` — ${refs.join(", ")}` : ""}.`,
  });

  return { title: payload.title, sections };
}
