import type {
  ListContextMomentsResponse,
  MemorySearchResponse,
} from "@nova/schema";
import { revalidatePath } from "next/cache";
import { ConfirmSubmit } from "./components/ConfirmSubmit";
import { API_URL, apiGet, apiPost, authHeaders } from "./lib/api";

export const dynamic = "force-dynamic";

async function deleteMoment(formData: FormData) {
  "use server";
  const id = formData.get("id");
  if (typeof id !== "string") return;
  await fetch(`${API_URL}/v1/context/moments/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  revalidatePath("/");
}

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() || null;

  let items: Array<
    ListContextMomentsResponse["items"][number] & { score?: number; match?: string }
  >;
  let legsNote: string | null = null;

  if (query) {
    const result = await apiPost<MemorySearchResponse>("/v1/memory/search", {
      query,
      limit: 50,
    });
    if (!result.ok) return <div className="error-banner">{result.message}</div>;
    items = result.data.items;
    legsNote = result.data.legs.vector
      ? "keyword + semantic search"
      : "keyword search (semantic search needs embeddings)";
  } else {
    const result = await apiGet<ListContextMomentsResponse>(
      "/v1/context/moments?limit=50",
    );
    if (!result.ok) return <div className="error-banner">{result.message}</div>;
    items = result.data.items;
  }

  return (
    <>
      <form className="search-form" action="/" method="get">
        <input
          type="search"
          name="q"
          placeholder="Search your memory…"
          defaultValue={query ?? ""}
        />
        <button type="submit">Search</button>
      </form>

      {items.length === 0 ? (
        <div className="empty">
          {query ? (
            <p>No moments match “{query}”.</p>
          ) : (
            <>
              <p>No context moments yet.</p>
              <p className="muted">
                Open the Nova side panel on any page, click “Capture this page”,
                add your instruction, and it will show up here.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <p className="muted">
            {items.length} moment{items.length === 1 ? "" : "s"}
            {query ? ` matching “${query}” · ${legsNote}` : ", newest first"}
          </p>
          {items.map((m) => {
            // M8: media pipeline refs first; legacy pre-backfill moments may
            // still carry an inline (already redacted) payload screenshot.
            const mediaShot = (m as { media?: Array<{ id: string; thumbnail_url: string | null }> })
              .media?.[0];
            const legacyShot = m.payload.screenshot_data_url;
            const imageState = (m.image_redaction?.state as string | undefined) ?? undefined;
            const blockedNote =
              imageState === "blocked_strict"
                ? "Screenshot blocked by strict redaction"
                : imageState === "storage_disabled"
                  ? "Screenshot storage is disabled"
                  : imageState === "media_unavailable"
                    ? "Screenshot dropped — media pipeline unavailable"
                    : null;
            const title = m.source_meta.title ?? "Untitled capture";
            return (
              <article className="moment-card" key={m.id}>
                {mediaShot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/media/${mediaShot.id}${mediaShot.thumbnail_url ? "?variant=thumb" : ""}`}
                    alt={`Screenshot of ${title}`}
                  />
                ) : typeof legacyShot === "string" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={legacyShot} alt={`Screenshot of ${title}`} />
                ) : blockedNote ? (
                  <div className="media-note">{blockedNote}</div>
                ) : null}
                <div className="moment-body">
                  <p className="moment-title">
                    {title}
                    {m.intent_parsed && (
                      <span className="badge">
                        {m.intent_parsed.action_type.replace(/_/g, " ")}
                      </span>
                    )}
                    {m.enrichment_status && m.enrichment_status !== "completed" && (
                      <span className={`badge enrich-${m.enrichment_status}`}>
                        {m.enrichment_status}
                      </span>
                    )}
                  </p>
                  {m.summary && <p className="muted">{m.summary}</p>}
                  {(() => {
                    // M11: enrichment provenance — latest version, provider/
                    // model, and how deep the history goes. Failed/skipped
                    // runs already show as a badge on the title above.
                    const meta = (
                      m as {
                        enrichment_meta?: {
                          latest_version: number;
                          versions: number;
                          provider: string | null;
                          model: string | null;
                          created_at: string;
                        } | null;
                      }
                    ).enrichment_meta;
                    if (!meta) return null;
                    return (
                      <div className="muted enrichment-meta">
                        Enrichment v{meta.latest_version}
                        {meta.provider ? ` · ${meta.provider}` : ""}
                        {meta.model ? ` (${meta.model})` : ""}
                        {" · "}
                        {new Date(meta.created_at).toLocaleDateString()}
                        {meta.versions > 1 ? ` · ${meta.versions - 1} previous` : ""}
                      </div>
                    );
                  })()}
                  {m.source_meta.url && (
                    <div className="moment-url">
                      <a href={m.source_meta.url} target="_blank" rel="noreferrer">
                        {m.source_meta.url}
                      </a>
                    </div>
                  )}
                  <div className="muted">
                    {new Date(m.captured_at).toLocaleString()} ·{" "}
                    {m.source_mode === "live_context" ? "live session" : "capture"}
                    {m.match && m.match !== "filter" ? ` · match: ${m.match}` : ""}
                  </div>
                  {m.intent_text && (
                    <p className="moment-intent">“{m.intent_text}”</p>
                  )}
                  <form action={deleteMoment} className="moment-delete">
                    <input type="hidden" name="id" value={m.id} />
                    <ConfirmSubmit message="Delete this moment and everything derived from it (tasks, actions, embeddings)? This cannot be undone.">
                      Delete
                    </ConfirmSubmit>
                  </form>
                </div>
              </article>
            );
          })}
        </>
      )}
    </>
  );
}
