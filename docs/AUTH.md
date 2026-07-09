# Authentication & User Isolation (M5)

How Nova Context authenticates users across the API, web app, and browser
extension, and how per-user data isolation is enforced. This documents what
is **built and tested**, not aspiration — the long-term developer-platform
design (OAuth 2.1 + PKCE + scopes for third parties) stays in
[API_AND_SDK_SPEC.md](API_AND_SDK_SPEC.md).

## The chosen approach: password login + opaque server-side sessions

For a first-party, private-alpha product with exactly three clients we own
(web app, extension, tests), the boring, auditable choice is:

- **Email + password** accounts. Passwords hashed with Node's built-in
  **scrypt** (N=2^17, r=8, p=1, per-hash salt, parameters stored in the
  hash so they can be raised later). No external auth dependency, no IdP.
- **Opaque session tokens** (256-bit random, `nova_sess_`/`nova_ext_`
  prefixed). The database stores only the SHA-256 of the token — a DB dump
  contains no usable credentials. Sessions have fixed expiry
  (`NOVA_SESSION_TTL_HOURS`, default 7 days web; 30 days extension), a
  `last_used_at` trail, and a `revoked_at` kill switch.
- **One credential shape at the API**: `Authorization: Bearer <token>`.
  The API reads **no cookies**, so cross-site request forgery has no
  ambient credential to ride on.

### Why not OAuth 2.1/PKCE now?

OAuth's value is delegating auth *across trust boundaries* (third-party
apps, external IdPs). M5 has none: every client is first-party. Standing up
an authorization server (or depending on a hosted one) would add moving
parts without adding security for this topology. The session model above is
the well-trodden "server-side session" pattern; when the developer platform
opens the API to third parties, OAuth 2.1 + PKCE + scopes layers on top of
these same `sessions`/`users` tables (the schema was built for it).
**Limitations accepted:** no SSO, no passkeys, password reset is manual
(operator resets `password_hash`) — acceptable for a private alpha, revisit
before any public beta.

## Per-surface flows

### Web app (Next.js)

- `/login` posts to a server action → `POST /v1/auth/login` → the token is
  stored in an **HttpOnly, SameSite=Lax, Secure-in-production cookie on the
  web app's origin**. Client JS can never read it.
- Every page/server action forwards the cookie value as a Bearer header
  server-side (`app/lib/api.ts`). The browser itself never calls the API.
- Middleware redirects cookie-less visitors to `/login`; any API 401
  (expired/revoked) redirects to `/login?error=expired`.
- Export downloads go through `/export`, a same-origin proxy that attaches
  the token server-side and streams the API response.
- Sign out = server action → `POST /v1/auth/logout` (revokes the session
  row) + cookie deletion.
- CSRF: Next server actions enforce same-origin; the cookie is SameSite=Lax;
  and the API accepts only Bearer headers — three independent layers.

### Browser extension (pairing flow)

The extension never sees a password. Connecting:

1. User signs in on the web app → Settings → Browser extension →
   **Generate pairing code** (`POST /v1/auth/pairing-codes`, allowed only
   for `web`-kind sessions so an extension token cannot breed credentials).
2. Code is 8 digits, stored hashed, **expires in 10 minutes, works once**
   (claimed atomically).
3. Extension submits it (`POST /v1/auth/pairing/claim`) and receives its own
   **extension-kind session token**, stored in `chrome.storage.local` — the
   only credential the extension holds. The account email is kept for
   display only.
4. Every extension request goes through `authFetch`: on any 401 the stored
   token is wiped and all UI surfaces converge on the Connect screen with a
   re-pair prompt. Disconnect (in extension settings) revokes the session
   server-side *and* forgets it locally; the web Settings page can also
   revoke any extension session remotely.

Trade-offs: a pairing code is phishable in principle (someone could ask a
user to read a code aloud) — mitigated by the 10-minute/single-use window
and by codes being mintable only from a signed-in web session. The token in
`chrome.storage.local` is readable by anything that can already read the
profile directory (same class of access as the browser's own cookies);
Chrome's `storage.session` was rejected because live-mode users expect the
pairing to survive browser restarts.

### Tests / CI

Integration suites sign in for real: M0–M4 regression files log in as the
seeded dev user; the auth/isolation suites create fresh accounts through the
public signup endpoint. Nothing bypasses the middleware.

## Authorization middleware (fail closed)

`services/api/src/auth/plugin.ts` runs on **every** `/v1` request. The only
public routes are the explicit allowlist: `POST /v1/auth/signup`,
`POST /v1/auth/login`, `POST /v1/auth/pairing/claim` (all rate-limited
in-process: 30 attempts / 15 min / IP). Everything else — including any
route added in the future — requires a live session or gets **401**.

Ownership stays in each route's SQL: every query on a user-owned table
carries `user_id = <authenticated user>`. Cross-user access returns **404**
(not 403), so resource existence never leaks. The isolation suite
(`test/integration/isolation.test.ts`) proves User B cannot read, list,
search, export, delete, complete, approve, or reject anything of User A's —
moments (instant and live-saved), projects, tasks, actions, audit rows,
sessions, product events, embeddings.

## Database changes (`migrations/0005_m5_auth.sql`)

- `users.password_hash text` (NULL = cannot log in).
- `sessions` (id, user_id, `token_hash` unique, kind `web|extension`,
  created/expires/last_used/revoked timestamps, label).
- `pairing_codes` (id, user_id, `code_hash` unique, expiry, claimed_at).

**Migration behavior for existing data:** nothing is rewritten. All M0–M4
rows already carry the seeded dev user's `user_id`; that account simply
became a normal account with no password. To keep using that data locally,
run `pnpm --filter @nova/api db:seed-dev` (sets a password for
`dev@nova.local`; refuses to run when `NODE_ENV=production`) and sign in as
`dev@nova.local` / `nova-dev-password` (override via `NOVA_DEV_PASSWORD`).

## Environment variables

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `NOVA_SIGNUP` | api | `open` (dev) / `invite` (prod) | `open` \| `invite` \| `closed` |
| `NOVA_ALPHA_INVITE_CODE` | api | unset | Required by `invite` mode; in production, missing code ⇒ signup fails closed |
| `NOVA_SESSION_TTL_HOURS` | api | 168 | Web session lifetime |
| `NOVA_EXTENSION_SESSION_TTL_HOURS` | api | 720 | Extension session lifetime |
| `NODE_ENV` | api, web | — | `production` switches signup default to invite-only and marks the web cookie `Secure` |
| `NOVA_DEV_PASSWORD` | api (script) | `nova-dev-password` | Password set by `db:seed-dev` |
| ~~`NOVA_API_TOKEN`~~ | — | **removed** | The M0 shared token is gone from API, web, and extension |

Development vs production, concretely: dev = open signup, non-Secure
cookie on localhost, `db:seed-dev` available. Production = invite-only by
default, Secure cookie, seed script refuses to run, no dev-user fallback
anywhere in runtime code (grep `dev@nova.local` — it appears only in the
seed migration, the seed script, and tests).

## Auditing

New payload-free audit events: `auth.signup`, `auth.login`, `auth.logout`,
`auth.session.revoke`, `auth.extension.paired`. Tokens, codes, and password
material never appear in the audit log (asserted in the auth suite).

## Notion OAuth — design notes only (deliberately not built)

Per the M5 scope, external writes stay gated. When M6 activates the
prepared `NotionAdapter`:

1. **Connect flow**: web Settings → "Connect Notion" → standard OAuth
   authorization-code flow against `api.notion.com/v1/oauth/authorize`,
   redirect URI on the **web app** (`/integrations/notion/callback`), which
   forwards the code to the API. PKCE isn't supported by Notion's
   integration OAuth today; the client secret lives only in the API env.
2. **Storage**: exchange the code server-side; encrypt the access token
   with a KMS/`NOVA_KMS_KEY`-derived key into the existing
   `integration_connections.token_ciphertext` (schema already has
   provider/scopes/status and `UNIQUE (user_id, provider)`).
3. **Isolation**: connections are per-user rows; the adapter must load the
   connection by the *authenticated* user id at execute time — never a
   global token.
4. **Execution**: keep preview → approve → execute → audit exactly as the
   adapter interface already defines; `integration.call` audit events with
   metadata only. Disconnect = revoke via Notion API + status `revoked`.
5. **Failure modes to design for**: token expiry/rotation, workspace
   permission changes mid-flight, and rate limits — execution should move
   to a worker job (approvals currently execute inline; fine for
   `nova_task`, not for network calls to Notion).
