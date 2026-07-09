import type { CreateContextMomentRequest } from "@nova/schema";

/**
 * Injected into the active tab via chrome.scripting.executeScript.
 * MUST be self-contained: it is serialized and run in the page, so it cannot
 * reference anything outside its own body.
 */
export function extractPageContext() {
  const clamp = (s: string | null | undefined, max: number) =>
    (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  const headings = Array.from(
    document.querySelectorAll("h1, h2, h3"),
  )
    .map((h) => clamp(h.textContent, 512))
    .filter(Boolean)
    .slice(0, 50);

  const metaDescription = clamp(
    document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content"),
    2000,
  );

  const selection = clamp(window.getSelection()?.toString(), 20_000);

  return {
    title: clamp(document.title, 1024),
    url: location.href.slice(0, 4096),
    main_text: clamp(document.body?.innerText, 50_000),
    selected_text: selection || null,
    meta_description: metaDescription,
    headings,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

export type PageContext = ReturnType<typeof extractPageContext>;

/** Downscale the captureVisibleTab image so the stored thumbnail stays small. */
export async function downscaleDataUrl(
  dataUrl: string,
  maxWidth = 800,
  quality = 0.75,
): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("screenshot decode failed"));
    img.src = dataUrl;
  });
  const scale = Math.min(1, maxWidth / img.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

export interface CaptureDraft {
  page: PageContext;
  screenshotDataUrl: string | null;
}

/** Grab everything visible about the active tab: DOM extract + screenshot. */
export async function captureActiveTab(): Promise<CaptureDraft> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active tab to capture.");
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContext,
  });
  const page = injection?.result as PageContext | undefined;
  if (!page) {
    throw new Error(
      "Could not read this page (browser-internal pages can't be captured).",
    );
  }

  let screenshotDataUrl: string | null = null;
  try {
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 85,
    });
    screenshotDataUrl = await downscaleDataUrl(raw);
  } catch {
    // Screenshot can fail on protected pages; DOM extract alone still makes
    // a useful moment. Never block capture on the thumbnail.
    screenshotDataUrl = null;
  }

  return { page, screenshotDataUrl };
}

/** Shape a capture draft + typed instruction into the API contract. */
export function toCreateMomentRequest(
  draft: CaptureDraft,
  intentText: string,
  projectId: string | null,
): CreateContextMomentRequest {
  const { page } = draft;
  return {
    source_mode: "instant_capture",
    source_meta: {
      url: page.url,
      title: page.title || undefined,
      viewport: page.viewport,
    },
    payload: {
      dom_extract: {
        main_text: page.main_text || undefined,
        selected_text: page.selected_text,
        meta_description: page.meta_description || undefined,
        headings: page.headings,
      },
      ...(draft.screenshotDataUrl
        ? { screenshot_data_url: draft.screenshotDataUrl }
        : {}),
    },
    extracted_text: [page.title, page.main_text].filter(Boolean).join(". "),
    intent_text: intentText.trim() || null,
    project_id: projectId,
  };
}
