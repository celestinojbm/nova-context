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
    /** M9: explicit properties for a database parent (from the user's
     * validated mapping). Undefined = title-only (M6 behavior). */
    properties?: Record<string, unknown>,
    /** M10: file-upload ids of explicitly approved, redacted media —
     * attached as image blocks after the content sections. */
    mediaUploadIds?: string[],
  ): Promise<CreatedNotionPage>;
  /** M9: live property schema of a database (name → type). */
  getDatabaseProperties(token: string, databaseId: string): Promise<Map<string, string>>;
  /** M10: push one media file into the workspace via Notion's File Upload
   * API; the returned id attaches to blocks. Never inline base64. */
  uploadMedia(
    token: string,
    filename: string,
    contentType: string,
    data: Buffer,
  ): Promise<{ id: string }>;
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
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`https://api.notion.com/v1${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "notion-version": NOTION_VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
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

  async getDatabaseProperties(token: string, databaseId: string): Promise<Map<string, string>> {
    const body = await this.call(token, `/databases/${databaseId}`);
    const props = (body.properties ?? {}) as Record<string, { type?: string }>;
    return new Map(Object.entries(props).map(([name, p]) => [name, p.type ?? "unknown"]));
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

  async uploadMedia(
    token: string,
    filename: string,
    contentType: string,
    data: Buffer,
  ): Promise<{ id: string }> {
    // Notion File Upload API: create the upload object, then send the
    // bytes as multipart form data. Both legs share the transient/terminal
    // error semantics of every other call.
    const created = await this.call(token, "/file_uploads", {
      filename,
      content_type: contentType,
    });
    const uploadId = created.id as string;
    let res: Response;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(data)], { type: contentType }), filename);
      res = await fetch(`https://api.notion.com/v1/file_uploads/${uploadId}/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "notion-version": NOTION_VERSION,
        },
        body: form,
      });
    } catch (err) {
      throw new NotionTransientError(`notion upload unreachable: ${(err as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new NotionTransientError(`notion upload responded ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`notion rejected the media upload (${res.status})`);
    }
    return { id: uploadId };
  }

  async createPage(
    token: string,
    parent: NotionParent,
    content: NotionPageContent,
    properties?: Record<string, unknown>,
    mediaUploadIds?: string[],
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
    // M10: explicitly approved media attaches by upload id — the page body
    // never carries pixels or base64.
    for (const uploadId of mediaUploadIds ?? []) {
      children.push({
        object: "block",
        type: "image",
        image: { type: "file_upload", file_upload: { id: uploadId } },
      });
    }
    const body = await this.call(token, "/pages", {
      parent:
        parent.type === "page_id"
          ? { page_id: parent.id }
          : { database_id: parent.id },
      // M9: a database parent may carry the user's validated property
      // mapping; pages (and unmapped databases) keep the M6 title-only shape.
      properties: properties ?? {
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
