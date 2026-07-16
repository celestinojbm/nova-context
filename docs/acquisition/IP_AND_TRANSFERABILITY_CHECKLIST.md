# IP & Transferability Checklist — baseline `74ac864c` (2026-07-16)

Two strictly separated halves: what the repository itself can evidence, and
what only private, off-repository records can evidence. **Ownership of Nova
Context is NOT VERIFIED** — do not assert that it is personally owned or
owned by Stravos Enterprises LLC until documentary evidence exists. Nothing
here is a legal conclusion.

## A. Repository-verifiable items

| Item | Finding at baseline | Status |
|---|---|---|
| Git contributors | Two *recorded* identities: `celestinojbm <celestinojbm@gmail.com>` (operator account) and `Claude <noreply@anthropic.com>` (AI-assistant co-author trailers). Recorded identities do not by themselves establish distinct legal contributors — each requires operator classification: same person via multiple accounts / automated-AI co-author / actual third party / unknown. No external human contribution is asserted | verified as-recorded; legal classification not verified |
| Repository ownership (hosting) | GitHub `celestinojbm/nova-context` (personal account, not an org) | verified complete |
| Repository license file | **ABSENT** — no LICENSE/COPYING; default all-rights-reserved but posture unstated (R-13). This is a *usage-permission* question, strictly separate from ownership (R-01): a LICENSE file would not prove who owns the IP, and none should be adopted until the owner and intended posture are determined (no posture — open-source, source-available, or proprietary — is assumed here) | absent (posture undecided) |
| Dependency licenses | 212 prod packages enumerated: MIT 159, Apache-2.0 34, BSD-2/3 7, ISC 6, 0BSD/Unlicense/BlueOak/pako 4, **LGPL-3.0-or-later 1** (`@img/sharp-libvips-linux-x64`, transitive), **CC-BY-4.0 1** (`caniuse-lite` data) | verified partial (direct verified; full transitive legal review pending) |
| Notices/attributions | No NOTICE file (Apache-2.0 and CC-BY components warrant one) | absent |
| Source & asset inventory | 10 workspaces; only non-code asset: `eng.traineddata` (Tesseract language data, Apache-2.0 upstream) | verified complete |
| External provider integrations | Anthropic SDK (enrichment/live-QA), OpenAI HTTP (transcription/embeddings), Notion OAuth + API, S3-compatible storage, Fly.io deploy configs | verified complete |
| Generated fixtures & media | Test fixtures are synthetic/generated in-test (Jimp-drawn images, fake strings); no third-party media found | verified complete |
| Model/dataset usage | No bundled models; Tesseract lang data vendored; cloud models opt-in via keys (default OFF) | verified complete |
| AI-assisted development disclosure | Co-author trailers exist in git and identify the tooling verifiable from the repo: Anthropic Claude models via the Claude Code CLI (trailers + session links in commit messages). Trailers are **provenance signals requiring documentation and terms review — they do not by themselves prove third-party ownership**, and no legal conclusion is drawn here. **No provenance/policy statement in-repo**; provider terms and human-review practices flagged for professional review | verified partial |
| Third-party code references | No vendored third-party source directories found; all external code via package manager | verified complete (to inspection depth) |

## B. Private / off-repository items (operator must verify; NEVER commit the documents)

Status is `not verified` until the operator produces evidence into private
storage. "Location" is a storage *category*, never an actual path.

| Record | Expected owner | Status | Storage location (category) | Professional review |
|---|---|---|---|---|
| Legal owner of Nova Context (personal vs. Stravos Enterprises LLC) | operator decision | **not verified** | corporate records vault | legal |
| Signed IP assignment (operator → owning entity) | owning entity | not verified | corporate records vault | legal |
| Contributor/contractor assignments (none known; policy needed before any) | owning entity | not applicable today / policy absent | corporate records vault | legal |
| Employment/contractor agreements | owning entity | not verified | corporate records vault | legal |
| Company formation + good standing (if LLC route) | owning entity | not verified | corporate records vault | legal + accounting |
| Domain ownership (product domains) | owning entity | not verified | registrar account records | operator |
| Trademark status ("Nova Context") | owning entity | not verified | legal files | legal |
| Provider account ownership (GitHub, Fly.io, Anthropic, OpenAI, Notion, S3/storage) | owning entity | not verified | account inventory (private) | operator |
| Payment/billing account ownership | owning entity | not verified | finance records | accounting |
| Contracts (none known) | owning entity | not applicable today | contracts vault | legal |
| Financial records / tax matters | owning entity | not verified | finance records | accounting |
| Insurance | owning entity | not verified | finance records | accounting |
| Customer agreements / privacy policy / ToS (needed BEFORE real alpha users) | owning entity | absent | legal files | legal |

## C. Standing rules

- Adopt a CLA/assignment policy **before** accepting any external
  contribution (R-12).
- Chain of title first (R-01): owner decision + assignments. Then — and only
  then — decide and record the repository licensing posture (R-13) with
  legal review; no posture is assumed or pre-selected here, and no LICENSE
  file is committed before that decision.
- Add a NOTICE file covering Apache-2.0/CC-BY attribution and the AI-assisted
  development provenance statement.
