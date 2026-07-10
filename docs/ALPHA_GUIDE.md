# Nova Context — private alpha guide

For the first alpha user. Ten minutes to set up; the privacy section is the
part worth reading twice.

## 1. Create your account

1. Open the web app URL the operator gave you → **Sign up**.
2. You need the **invite code** from the operator (signups are invite-only).
3. Pick a real password (10+ characters) — there is no email recovery; the
   operator can issue a reset link if you lose it.

## 2. Consent first

The first screen explains what Nova captures and asks for explicit consent
before anything is stored. Nothing is captured until you finish onboarding
AND explicitly trigger a capture.

## 3. Install and pair the extension

1. Get the extension zip from the operator (or build:
   `pnpm --filter @nova/extension zip`), unzip it.
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
   select the unzipped folder.
3. Web app → **Settings → Browser extension** → generate a pairing code.
4. Extension side panel → set the API URL (from the operator) → paste the
   code. The extension gets its own revocable session — it never sees your
   password. You can revoke it any time in Settings → Sessions.

## 4. First capture test

1. Open any normal webpage. Extension panel → type an instruction like
   "remember this for the alpha test" → **Capture**.
2. The result shows what happened, including what redaction did.
3. Web app timeline → the moment appears, with a thumbnail if a screenshot
   was stored. Search for a word from the page — it should come back.

## 5. Live context test (optional, config-dependent)

Extension panel → **Live** → start a session. A visible indicator shows
while it runs; frames stay in a rolling in-memory buffer on your machine.
Ask a question about what's on screen (works only if the operator enabled
live Q&A). **Save moment** persists the current context; ending the session
destroys the buffer — only explicitly saved moments survive.

## 6. Connect Notion (optional)

Settings → Integrations → **Connect Notion** → authorize a workspace and
share at least one page with the integration. Nova NEVER writes to Notion
on its own: every page creation is a proposed action you approve first,
with a preview of exactly what will be written. Screenshots go to Notion
only if you tick them, one by one, at approval time.

## 7. What Nova captures — and never captures

Captured **only when you act** (capture click, live session you started,
voice you recorded):

- page title, URL, visible text, your selection, your typed/spoken
  instruction, and (unless you choose text-only) a screenshot that is
  **redaction-masked before storage** (emails, phones, cards, API keys,
  SSNs, IBANs in text; OCR-boxed sensitive regions in images);
- screenshots are encrypted at rest and only ever served back to you,
  authenticated.

Never, structurally:

- **no silent background capture** — no timers, no auto-capture, nothing
  while you're not pressing a button or running a visible live session;
- no captured content in logs, audit entries, or analytics (analytics are
  allowlisted event names + counts only);
- no plaintext integration tokens, no unencrypted media at rest;
- no external writes (Notion or anything else) without your explicit
  approval of a previewed action.

## 8. Known privacy limitations (honest list)

- Redaction is detector-based: stylized/tiny/rotated text, faces, QR codes,
  and unusual formats can slip past OCR masking. Use blurred or text-only
  capture modes on high-risk screens (extension settings), or strict mode
  to drop images that can't be redacted.
- Live Q&A (if enabled) sends the already-redacted live buffer slice to a
  cloud model (Anthropic); transcription (if enabled) sends your voice clip
  to OpenAI. Both are off unless the operator configured them; the audit
  log records every cloud call.
- The operator can see counts, sizes, categories, and event names — never
  your captured content.

## 9. Your data is yours

- **Export**: Settings → "Full account export" (JSON, optionally with media
  inlined) any time.
- **Delete**: any moment from the timeline; the whole account from
  Settings → Delete account (password + typed DELETE). Deletion removes
  everything, immediately — what survives is a counts-only tombstone.
  Pages Nova created in your Notion stay in your Notion.
- The audit page shows every capture, cloud call, action, sign-in, export,
  and deletion.

## 10. Reporting bugs and friction

Settings → **Report a problem** — pick a category (bug, privacy concern,
capture/search/live/Notion failure, UX friction, feature request) and
describe what happened. **Text only — please don't paste screenshots or
captured content**; say what you did and what you expected instead. Privacy
concerns get triaged first. The operator reviews feedback weekly
(`ops:report`).

## A note on the browser shell (M12)

`apps/browser-shell` remains an experimental spike. The extension is the
primary alpha surface; the shell may be tested manually only if the
extension shows clear limitations for you (e.g. screenshots failing on
occluded windows). No packaging or browser feature expansion is planned in
M13.
