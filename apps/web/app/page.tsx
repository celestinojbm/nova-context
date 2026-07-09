import type { ListContextMomentsResponse } from "@nova/schema";

export const dynamic = "force-dynamic";

const API_URL = process.env.NOVA_API_URL ?? "http://localhost:3001";
const API_TOKEN = process.env.NOVA_API_TOKEN;

async function fetchMoments(): Promise<
  | { ok: true; data: ListContextMomentsResponse }
  | { ok: false; message: string }
> {
  try {
    const res = await fetch(`${API_URL}/v1/context/moments?limit=50`, {
      cache: "no-store",
      headers: API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {},
    });
    if (!res.ok) {
      return { ok: false, message: `API responded ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as ListContextMomentsResponse };
  } catch {
    return {
      ok: false,
      message: `Could not reach the Nova API at ${API_URL}. Is services/api running?`,
    };
  }
}

export default async function TimelinePage() {
  const result = await fetchMoments();

  if (!result.ok) {
    return <div className="error-banner">{result.message}</div>;
  }

  const { items } = result.data;
  if (items.length === 0) {
    return (
      <div className="empty">
        <p>No context moments yet.</p>
        <p className="muted">
          Open the Nova side panel on any page, click “Capture this page”, add
          your instruction, and it will show up here.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="muted">
        {items.length} moment{items.length === 1 ? "" : "s"}, newest first
      </p>
      {items.map((m) => {
        const screenshot = m.payload.screenshot_data_url;
        const title = m.source_meta.title ?? "Untitled capture";
        return (
          <article className="moment-card" key={m.id}>
            {typeof screenshot === "string" && (
              // Screenshot thumbnails are data URLs in M0 (no object storage
              // yet), so next/image adds nothing here.
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
              </p>
              {m.source_meta.url && (
                <div className="moment-url">
                  <a href={m.source_meta.url} target="_blank" rel="noreferrer">
                    {m.source_meta.url}
                  </a>
                </div>
              )}
              <div className="muted">
                {new Date(m.captured_at).toLocaleString()} · {m.source_mode}
              </div>
              {m.intent_text && <p className="moment-intent">“{m.intent_text}”</p>}
            </div>
          </article>
        );
      })}
    </>
  );
}
