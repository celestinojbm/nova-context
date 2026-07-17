# IP & Transferability Checklist — baseline `74ac864c` (2026-07-16)

Two strictly separated halves: what the repository itself can evidence, and
what only private, off-repository records can evidence. **Ownership of Nova
Context is NOT independently VERIFIED.** M17D update: the operator now
**attests** that Nova is intended to be personally owned by the founder and
that Stravos Enterprises LLC is not the intended owner (`operator_attested`,
EV-17, `CHAIN_OF_TITLE_STATUS.md`) — this narrows the question but is not
documentary evidence; do not treat attestation as legal verification, and do
not assert Stravos ownership of any Nova asset. Nothing here is a legal
conclusion.

## A. Repository-verifiable items

| Item | Finding at baseline | Status |
|---|---|---|
| Git contributors | Two *recorded* identities: `celestinojbm <celestinojbm@gmail.com>` (operator account) and `Claude <noreply@anthropic.com>` (AI-assistant co-author trailers). M17D: the operator attests sole human contributorship, so the working classification is operator-account + AI-co-author-metadata (`operator_attested`, EV-17); final classification (same person via multiple accounts / automated-AI co-author / actual third party / unknown) is confirmed only at professional review (R-01). No external human contribution is asserted | verified as-recorded; classification operator_attested; legal confirmation pending |
| Repository ownership (hosting) | GitHub `celestinojbm/nova-context` (personal account, not an org) | verified complete |
| Repository license file | **ABSENT** — no LICENSE/COPYING; default all-rights-reserved but posture unstated (R-13). This is a *usage-permission* question, strictly separate from ownership (R-01): a LICENSE file would not prove who owns the IP, and none should be adopted until the owner and intended posture are determined (no posture — open-source, source-available, or proprietary — is assumed here) | absent (posture undecided) |
| Dependency licenses | 212 prod packages enumerated: MIT 159, Apache-2.0 34, BSD-2/3 7, ISC 6, 0BSD/Unlicense/BlueOak/pako 4, **LGPL-3.0-or-later 1** (`@img/sharp-libvips-linux-x64`, transitive), **CC-BY-4.0 1** (`caniuse-lite` data) | verified partial (direct verified; full transitive legal review pending) |
| Notices/attributions | No NOTICE file (Apache-2.0 and CC-BY components warrant one) | absent |
| Source & asset inventory | 10 workspaces; only non-code asset: `eng.traineddata` (Tesseract language data, Apache-2.0 upstream) | verified complete |
| External provider integrations | Anthropic SDK (enrichment/live-QA), OpenAI HTTP (transcription/embeddings), Notion OAuth + API, S3-compatible storage, Fly.io deploy configs | verified complete |
| Generated fixtures & media | Test fixtures are synthetic/generated in-test (Jimp-drawn images, fake strings); no third-party media found | verified complete |
| Model/dataset usage | No bundled models; Tesseract lang data vendored; cloud models opt-in via keys (default OFF) | verified complete |
| AI-assisted development disclosure | Co-author trailers exist in git and identify the tooling verifiable from the repo: Anthropic Claude models via the Claude Code CLI (trailers + session links in commit messages). M17D: the operator additionally attests use of ChatGPT, Hermes, and Codex, with outputs normally human-reviewed/directed before incorporation and no manual copying of external third-party code (`operator_attested`, EV-17 — the extra tools are not independently evidenced by git metadata). Trailers/attestations are **provenance signals requiring documentation and terms review — they do not by themselves prove third-party ownership**, no claim is made that AI-assisted output is automatically copyrightable, and no legal conclusion is drawn here. **No provenance/policy statement in-repo**; provider terms and human-review practices flagged for professional review | verified partial + operator_attested |
| Third-party code references | No vendored third-party source directories found; all external code via package manager | verified complete (to inspection depth) |

## B. Private / off-repository items (operator must verify; NEVER commit the documents)

Status semantics (M17D): `operator_attested` = fact supplied by the
operator, documentary verification still required; `not verified` = no
sufficient evidence. Nothing here is `private_document_verified` or
`professional_reviewed` yet. "Location" is a storage *category*, never an
actual path. Intended owner per attestation: **founder personally** (not
Stravos Enterprises LLC).

| Record | Expected owner | Status | Storage location (category) | Professional review |
|---|---|---|---|---|
| Legal owner of Nova Context | founder personally (intended) | **operator_attested; documentary verification pending** | corporate records vault | legal |
| Private signed authorship/ownership statement (founder) | founder personally | not verified (does not exist yet; do not commit it) | corporate records vault | legal |
| IP assignment / confirmation / waiver / no-claim instrument involving Stravos | founder + Stravos | **not currently planned** (stated strategy is personal ownership; none drafted here) — whether any such instrument is advisable is a question for professional legal review | corporate records vault | legal |
| Confirmation Stravos claims no Nova ownership (if legal review recommends) | founder + Stravos | not verified | corporate records vault | legal |
| Contributor/contractor assignments (none known; policy needed before any) | founder personally | none appear needed on the attested facts (sole human contributor operator_attested) — advisability confirmed only at professional review; policy absent | corporate records vault | legal |
| Employment/contractor agreements affecting Nova | founder personally | operator_attested: none relevant; verification pending | corporate records vault | legal |
| Company formation + good standing (Stravos — context only; existed during development, not intended owner) | Stravos Enterprises LLC | operator_attested existence; records not verified | corporate records vault | legal + accounting |
| Domain ownership (product domains) | founder personally (future) | operator_attested: **no Nova domain purchased** | registrar account records | operator |
| Trademark status ("Nova Context"; name origin not supplied) | founder personally (future) | not verified; no clearance performed | legal files | legal |
| Provider account ownership (GitHub, OpenAI, Anthropic, Notion, Render, Cloudflare/R2, registrar, Postgres, Redis) | founder personally | operator_attested personal control; proof pending (see `ACCOUNT_AND_ASSET_TRANSFERABILITY.md`) | account inventory (private) | operator |
| Payment/billing account ownership | founder personally | operator_attested (personally paid); records pending | finance records | accounting |
| Contracts (none known) | founder personally | not applicable today (operator_attested) | contracts vault | legal |
| Financial records / tax matters | founder personally | not verified | finance records | accounting |
| Insurance | founder personally | not verified | finance records | accounting |
| Customer agreements / privacy policy / ToS (needed BEFORE real alpha users) | founder personally | absent | legal files | legal |
| Development timeline / device-account history evidence (start ~June 2026, personal devices/accounts, no Stravos accounts) | founder personally | operator_attested; evidence pending | corporate records vault | legal |
| AI-provider account + terms records for the development period (Claude/Claude Code, ChatGPT, Hermes, Codex) | founder personally | operator_attested tool list; records pending | account inventory (private) | legal |

## C. Standing rules

- Adopt a CLA/assignment policy **before** accepting any external
  contribution (R-12).
- Chain of title first (R-01): owner decision + assignments. Then — and only
  then — decide and record the repository licensing posture (R-13) with
  legal review; no posture is assumed or pre-selected here, and no LICENSE
  file is committed before that decision.
- Add a NOTICE file covering Apache-2.0/CC-BY attribution and the AI-assisted
  development provenance statement.
