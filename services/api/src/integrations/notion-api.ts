import type { NotionDestination } from "@nova/schema";

/**
 * Read-only Notion API surface the API service needs (M7): list the pages
 * and databases the user shared with the integration so they can pick a
 * default destination. Injectable — tests use fakes; the worker keeps its
 * own client for writes.
 *
 * Notion API limitation, documented: there is no "list everything"
 * endpoint — /v1/search only returns objects the user explicitly shared
 * with the integration, ordered by last edit. That IS the safe selector:
 * the user controls the candidate set inside Notion itself.
 */
export interface NotionApiClient {
  listDestinations(token: string): Promise<NotionDestination[]>;
}

const NOTION_VERSION = "2022-06-28";
const PAGE_SIZE = 25;

export class HttpNotionApiClient implements NotionApiClient {
  async listDestinations(token: string): Promise<NotionDestination[]> {
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "notion-version": NOTION_VERSION,
      },
      body: JSON.stringify({
        page_size: PAGE_SIZE,
        sort: { direction: "descending", timestamp: "last_edited_time" },
      }),
    });
    if (!res.ok) {
      throw new Error(`notion search failed (${res.status})`);
    }
    const body = (await res.json()) as {
      results?: Array<Record<string, unknown>>;
    };
    const out: NotionDestination[] = [];
    for (const item of body.results ?? []) {
      if (item.object === "page") {
        out.push({
          id: item.id as string,
          type: "page_id",
          title: pageTitle(item) ?? "Untitled page",
        });
      } else if (item.object === "database") {
        out.push({
          id: item.id as string,
          type: "database_id",
          title: databaseTitle(item) ?? "Untitled database",
        });
      }
    }
    return out;
  }
}

function pageTitle(page: Record<string, unknown>): string | null {
  const props = page.properties as Record<string, unknown> | undefined;
  if (!props) return null;
  for (const value of Object.values(props)) {
    const prop = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (prop.type === "title" && prop.title?.length) {
      return prop.title.map((t) => t.plain_text ?? "").join("") || null;
    }
  }
  return null;
}

function databaseTitle(db: Record<string, unknown>): string | null {
  const title = db.title as Array<{ plain_text?: string }> | undefined;
  if (!title?.length) return null;
  return title.map((t) => t.plain_text ?? "").join("") || null;
}
