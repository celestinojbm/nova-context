import type { CreateContextMomentRequest } from "@nova/schema";

/**
 * M12 spike — capture logic for the Nova browser shell.
 *
 * Deliberately mirrors the extension's capture contract
 * (apps/extension/utils/capture.ts): same extraction fields, same clamps,
 * same CreateContextMomentRequest mapping. The shell is a second CLIENT of
 * the existing API — redaction, media encryption, audit, and enrichment all
 * happen server-side exactly as they do for extension captures. Nothing in
 * this module (or anywhere in the shell) stores captured content locally.
 *
 * Everything here is pure and Node-free so it can be unit-tested in CI and
 * replayed against the real API without an Electron binary.
 */

/**
 * Runs INSIDE the visited page via webContents.executeJavaScript. MUST be
 * self-contained: it is serialized with .toString(), so it cannot reference
 * anything outside its own body. The page is hostile territory — whatever
 * this returns is UNTRUSTED and must pass through sanitizePageContext.
 */
export function extractPageContext() {
  const clamp = (s: string | null | undefined, max: number) =>
    (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((h) => clamp(h.textContent, 512))
    .filter(Boolean)
    .slice(0, 50);

  const metaDescription = clamp(
    document.querySelector('meta[name="description"]')?.getAttribute("content"),
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

export type ShellPageContext = ReturnType<typeof extractPageContext>;

/** The serialized form injected into the page world. */
export const EXTRACT_PAGE_SCRIPT = `(${extractPageContext.toString()})()`;

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * The page's main world can tamper with DOM APIs, so the object returned by
 * EXTRACT_PAGE_SCRIPT is attacker-controlled. Re-validate every field in the
 * privileged process: coerce types, re-apply clamps, drop everything else.
 * Returns null when the result is unusable (browser-internal pages, a page
 * that replaced the return value with garbage, script failure).
 */
export function sanitizePageContext(raw: unknown): ShellPageContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const headings = Array.isArray(r.headings)
    ? r.headings
        .filter((h): h is string => typeof h === "string")
        .map((h) => str(h, 512))
        .filter(Boolean)
        .slice(0, 50)
    : [];

  const vp =
    typeof r.viewport === "object" && r.viewport !== null
      ? (r.viewport as Record<string, unknown>)
      : {};
  const dim = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000
      ? v
      : 1;

  const selected = str(r.selected_text, 20_000);
  return {
    title: str(r.title, 1024),
    url: typeof r.url === "string" ? r.url.slice(0, 4096) : "",
    main_text: str(r.main_text, 50_000),
    selected_text: selected || null,
    meta_description: str(r.meta_description, 2000),
    headings,
    viewport: { w: dim(vp.w), h: dim(vp.h) },
  };
}

export interface ShellCaptureDraft {
  page: ShellPageContext;
  screenshotDataUrl: string | null;
}

/**
 * Shape a capture draft + typed instruction into the existing API contract.
 * Identical mapping to the extension's toCreateMomentRequest, plus
 * source_meta.app so operators can tell shell captures from extension ones.
 * The page's text goes ONLY into payload/extracted_text — captured content
 * is data, never instruction: nothing a page says can change intent_text,
 * the project, or any control field.
 */
export function toCreateMomentRequest(
  draft: ShellCaptureDraft,
  intentText: string,
  projectId: string | null,
): CreateContextMomentRequest {
  const { page } = draft;
  return {
    source_mode: "instant_capture",
    source_meta: {
      ...(page.url ? { url: page.url } : {}),
      title: page.title || undefined,
      app: "nova-browser-shell",
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
