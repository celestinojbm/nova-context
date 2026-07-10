# @nova/browser-shell — M12 spike

A **minimal** Electron shell that answers one question: what does Nova
Context capture look like when Nova owns the browser chrome instead of
riding inside Chrome as an extension? It is a discovery prototype, not a
product. See `docs/NOVA_BROWSER.md` for the strategy, feasibility analysis,
architecture proposal, threat model, and the extension-vs-shell decision
table.

## What it does (and only this)

- Opens a URL in a fully sandboxed page view (no Node, no preload, no
  permissions — strictly less privileged than a page in Chrome).
- Shows a Nova side panel: pair with your account, navigate, capture.
- On an explicit **Capture** click: extracts title/URL/visible text,
  takes a downscaled screenshot (unless "text only"), and POSTs a
  standard Context Moment to the existing API — the same
  `CreateContextMomentRequest` contract the extension uses.
- Reports whether the capture succeeded, how many media items were
  stored, and what server-side redaction did.

No tabs, bookmarks, history, sync, passwords, downloads, or extensions.
No silent background capture — the only capture path is the button.
Redaction, media encryption, audit, and enrichment all happen server-side
exactly as they do for extension captures; the shell stores no captured
content locally, ever.

## Auth

Identical to the extension (M5): sign in on the web app, generate a
one-time pairing code (Settings → Browser extension), paste it into the
shell's Connection panel. The shell holds only its own revocable device
session token (0600 JSON file in Electron's `userData` dir — same trust
level as the extension's `chrome.storage.local`). Any 401 clears it.

## Run it locally

The Electron binary is NOT downloaded in CI (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`
in the workflow); locally it installs like any dependency:

```bash
pnpm install                      # electron is in root onlyBuiltDependencies
pnpm --filter @nova/browser-shell build
pnpm --filter @nova/browser-shell start
```

Prereqs: API running (`pnpm --filter @nova/api dev`, with Postgres/Redis
from `pnpm db:up`), web app running for the pairing code
(`pnpm --filter @nova/web dev`).

## Manual smoke (5 minutes)

1. Pair the shell (web app → Settings → Browser extension → new code).
2. Navigate to a real page; click **Capture this page** with an
   instruction like "remember this pricing page".
3. Panel shows `Saved moment <id> · media: 1 · redaction: applied`.
4. Web timeline shows the moment with thumbnail; the audit log shows the
   capture; `source_meta.app = "nova-browser-shell"` distinguishes it.
5. Tick **Text only**, capture again → `media: 0`, no pixels ever grabbed.
6. Disconnect → capture fails with a pairing prompt; the token is gone
   from Sessions in the web app.

## Tests

`pnpm --filter @nova/browser-shell test` — pure unit tests (payload shape
against the shared zod schema, hostile-page sanitization, instruction-as-
data, auth client behavior). They run in CI without an Electron binary.
The API-side integration test
(`services/api/test/integration/browser-shell.test.ts`) replays this
package's real payload builder against the real API: auth required,
redaction before storage, encrypted media, user isolation, log hygiene.

## Known limitations (deliberate, it's a spike)

- Single view, no tabs; `blurred` capture mode not implemented
  (`full`/`text_only` only).
- No live context mode (the extension's live session flow is out of scope
  for the spike; see docs/NOVA_BROWSER.md §Architecture for how it would
  integrate).
- No auto-update, crash reporting, or packaging — `electron .` only.
- Project picker not wired in the panel (captures land unassigned;
  moments can be assigned in the web app).
