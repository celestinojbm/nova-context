import type { NotionPageContent } from "@nova/context-engine";

/**
 * Minimal Notion API client (M6). Exactly what the notion_page action
 * needs: find a destination the user shared with the integration, create
 * one page. Injectable so the action worker is tested against a fake.
 */

export interface NotionParent {
  type: "page_id" | "database_id";
  id: string;
  title: string | null;
}

export interface CreatedNotionPage {
  id: string;
  url: string | null;
}

export interface NotionClient {
  /** First page/database the user granted the integration access to. */
  findParent(token: string): Promise<NotionParent | null>;
  createPage(
    token: string,
    parent: NotionParent,
    content: NotionPageContent,
  ): Promise<CreatedNotionPage>;
}

/** Transient provider trouble → retry; anything else is terminal. */
export class NotionTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionTransientError";
  }
}

const NOTION_VERSION = "2022-06-28";

export class HttpNotionClient implements NotionClient {
  private async call(
    token: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`https://api.notion.com/v1${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "notion-version": NOTION_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new NotionTransientError(`notion unreachable: ${(err as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new NotionTransientError(`notion responded ${res.status}`);
    }
    if (!res.ok) {
      // 4xx: bad token / revoked access / invalid parent — retrying won't help.
      throw new Error(`notion rejected the request (${res.status})`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async findParent(token: string): Promise<NotionParent | null> {
    const body = await this.call(token, "/search", {
      filter: { property: "object", value: "page" },
      page_size: 1,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    });
    const results = (body.results as Array<Record<string, unknown>>) ?? [];
    const first = results[0];
    if (!first) return null;
    return {
      type: "page_id",
      id: first.id as string,
      title: extractTitle(first),
    };
  }

  async createPage(
    token: string,
    parent: NotionParent,
    content: NotionPageContent,
  ): Promise<CreatedNotionPage> {
    const children = content.sections.flatMap((section) => {
      const blocks: Array<Record<string, unknown>> = [];
      if (section.heading) {
        blocks.push({
          object: "block",
          type: "heading_3",
          heading_3: { rich_text: [{ type: "text", text: { content: section.heading } }] },
        });
      }
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: section.text.slice(0, 2000) } }],
        },
      });
      return blocks;
    });
    const body = await this.call(token, "/pages", {
      parent:
        parent.type === "page_id"
          ? { page_id: parent.id }
          : { database_id: parent.id },
      properties: {
        title: {
          title: [{ type: "text", text: { content: content.title.slice(0, 200) } }],
        },
      },
      children,
    });
    return {
      id: body.id as string,
      url: typeof body.url === "string" ? body.url : null,
    };
  }
}

function extractTitle(page: Record<string, unknown>): string | null {
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
