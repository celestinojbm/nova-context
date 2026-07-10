import { describe, expect, it } from "vitest";
import { HttpNotionClient } from "../../src/notion-client.js";

/**
 * M11 gated LIVE smoke against the real Notion API. Never runs in CI —
 * set both env vars to run it manually:
 *
 *   NOVA_NOTION_SMOKE_TOKEN=secret_...   an integration token
 *   NOVA_NOTION_SMOKE_PARENT=<page-id>   a page shared with the integration
 *
 * It uploads a 1x1 PNG via the File Upload API and creates a page with the
 * image attached, then prints the page URL for manual cleanup. The full
 * real-provider checklist lives in infra/DEPLOY.md §Notion media smoke.
 */
const token = process.env.NOVA_NOTION_SMOKE_TOKEN;
const parentId = process.env.NOVA_NOTION_SMOKE_PARENT;

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!token || !parentId)("M11: Notion LIVE media smoke (gated)", () => {
  it("uploads media and creates a page with it attached", async () => {
    const notion = new HttpNotionClient();
    const upload = await notion.uploadMedia(token!, "nova-smoke.png", "image/png", PNG_1X1);
    expect(upload.id).toBeTruthy();
    const page = await notion.createPage(
      token!,
      { type: "page_id", id: parentId!, title: "smoke parent" },
      {
        title: `Nova live smoke ${new Date().toISOString()}`,
        sections: [{ heading: null, text: "Nova Context M11 live media smoke — safe to delete." }],
      },
      undefined,
      [upload.id],
    );
    expect(page.id).toBeTruthy();
    console.log(`smoke page created: ${page.url ?? page.id} (delete manually)`);
  }, 60_000);
});
