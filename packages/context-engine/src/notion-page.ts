/**
 * Notion page composition (M6). ONE builder produces both the preview the
 * user approves and the content the worker actually writes — what you see
 * on the approval card is what lands in Notion. Captured content stays
 * data: nothing here is interpreted, only quoted.
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

  if (source.sourceUrl) {
    sections.push({ heading: "Source", text: source.sourceUrl });
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

  const captured = source.capturedAt ? ` on ${source.capturedAt}` : "";
  sections.push({
    heading: null,
    text: `Captured with Nova Context${captured}${
      source.momentId ? ` — moment ${source.momentId}` : ""
    }.`,
  });

  return { title: payload.title, sections };
}
