import type {
  ListContextMomentsResponse,
  MemorySearchResponse,
} from "@nova/schema";
import { revalidatePath } from "next/cache";
import { API_URL, apiGet, apiPost, authHeaders } from "./lib/api";

export const dynamic = "force-dynamic";

async function deleteMoment(formData: FormData) {
  "use server";
  const id = formData.get("id");
  if (typeof id !== "string") return;
  await fetch(`${API_URL}/v1/context/moments/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
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
            const screenshot = m.payload.screenshot_data_url;
            const title = m.source_meta.title ?? "Untitled capture";
            return (
              <article className="moment-card" key={m.id}>
                {typeof screenshot === "string" && (
                  // Data-URL thumbnails in M0-M2; object storage arrives later.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={screenshot} alt={`Screenshot of ${title}`} />
                )}
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
                    <button type="submit" title="Delete this moment and everything derived from it">
                      Delete
                    </button>
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
