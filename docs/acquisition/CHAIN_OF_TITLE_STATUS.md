# Chain-of-Title Status — M17D (2026-07-17)

## 1. Purpose and limitations

Records the operator's chain-of-title attestation and separates it from
independently verified evidence, so R-01 can be narrowed honestly. This
document is **not** an IP assignment, an ownership certificate, a legal
opinion, a signed declaration, or a substitute for professional review. It
contains no identification numbers, addresses, signatures, or private
records. Nothing here is a legal conclusion.

**Evidence classes used** (see `README.md`):
`repository_verified` · `operator_attested` · `private_document_verified` ·
`professional_reviewed` · `not_verified`. Operator attestation never equals
legal verification. No item in this document is `private_document_verified`
or `professional_reviewed` — no such review has occurred yet.

## 2. Baseline

Main at `1597e6ccacff14e2cfff5fa24ca10a032fa2cb91` (M0–M17C, CI green).
Attestation supplied by the operator in July 2026 (EV-17).

## 3. Operator-attested facts

All of the following are `operator_attested` — supplied by the
founder/operator, not independently verified:

- Nova Context and its associated IP are **intended to remain personally
  owned by the founder/operator**; Nova is **not** intended to be owned by
  Stravos Enterprises LLC at this time.
- The preferred future transaction is a **sale of Nova as a personally owned
  technology asset**, not a sale of Stravos Enterprises LLC.
- Development began approximately **June 1, 2026**. Stravos Enterprises LLC
  already existed at that time; development used a personal computer and
  personal accounts, and **no Stravos accounts were used**. The mere
  existence of Stravos during development does not prove Stravos ownership.
- **No other human** wrote code, designed assets, contributed substantial
  documentation, or made substantial creative/architectural contributions.
  No contributor or contractor assignment is applicable on the facts
  currently supplied.
- AI tools used: **Claude / Claude Code, ChatGPT, Hermes, Codex**. AI output
  was normally reviewed or directed by the operator before incorporation.
- **No code was manually copied** from external websites, repositories,
  courses, public answers, or other third-party sources.
- The `celestinojbm` GitHub account is personally controlled; the repository
  is held in the operator's personal account; the operator personally pays
  for related services.
- No relevant employment/contractor invention or IP clauses applied during
  development; no collaboration agreement, oral participation promise,
  informal partnership, prior assignment, or other known agreement affects
  Nova ownership.
- Provider accounts stated as personally owned/controlled and personally
  paid: OpenAI, Anthropic, Notion, GitHub, Render, Cloudflare (incl. R2),
  domain registrar, Postgres provider, Redis provider.

## 4. Repository-verified facts

- Git history contains exactly two recorded identities: the operator account
  and AI-assistant co-author trailers (EV-14).
- Commit trailers and session links evidence Claude/Claude Code as tooling;
  the other attested tools (ChatGPT, Hermes, Codex) are referenced in
  documentation (Hermes audit records) but are not independently evidenced
  as authorship tooling by git metadata.
- No vendored third-party source directories found; external code arrives
  via the package manager (see `DEPENDENCY_AND_LICENSE_INVENTORY.md`).
- Test fixtures are generated in-test; no third-party media found to
  inspection depth.
- Repository hosted at `celestinojbm/nova-context` (personal account).

## 5. Facts not independently verified

- Legal ownership of the IP by the founder personally.
- Absence of unknown competing claims or obligations.
- The attested development timeline and device/account history.
- Personal control and billing of each provider account.
- Absence of manually copied third-party code (attested; consistent with
  inspection, but inspection cannot prove a negative).

## 6. Human-contributor status

Operator attests they are the **sole human contributor** (code, assets,
documentation, architecture). Repository history is consistent: no third
human identity appears. Do **not** infer an additional human contributor
from git identities or AI co-author trailers. Independent verification
(private records + professional review) is still required.

## 7. AI-assisted-development provenance

Tools (operator_attested): Claude / Claude Code, ChatGPT, Hermes, Codex.
Outputs normally human-reviewed/directed before incorporation
(operator_attested). AI assistance does **not** by itself create third-party
ownership, and no claim is made that every AI-assisted contribution is
automatically copyrightable — AI-authorship treatment is an open legal
question flagged for professional review, together with each provider's
terms as of the development period.

## 8. Personal vs. company ownership position

Intended owner: **the founder personally** (operator_attested). Stravos
Enterprises LLC: existed during development, was not used for development
accounts, is **not claimed to own any Nova asset**, and is not the intended
owner at this time. No operator→Stravos assignment is required under the
stated strategy; revisit only if the strategy changes. Personal ownership is
**not legally proven** by this document.

## 9. Repository/account ownership

GitHub account and repository: personally controlled (operator_attested;
hosting location repository_verified). Provider accounts as listed in §3
(operator_attested). Account ownership does **not** prove Nova production
resources exist: no domain has been purchased, no real deployment has
occurred, and no Nova production infrastructure is verified to exist on
Render, Cloudflare/R2, or any Postgres/Redis provider.

## 10. Third-party asset status

Operator attests no external images, datasets, fonts, icons, audio, video,
or manually copied external code were knowingly used beyond declared
dependencies. Repository inspection is consistent (fixtures generated
in-test). Dependency licenses are inventoried separately
(`DEPENDENCY_AND_LICENSE_INVENTORY.md`, R-06). The origin/selection
rationale for the name "Nova Context" was **not supplied** and remains
unverified; no domain purchased; no logo or formal visual identity exists;
no trademark clearance performed (R-11).

## 11. Prior-obligation status

Operator attests: no employment or contractor agreement with relevant
invention/IP clauses applied during development; no collaboration agreement;
no oral participation promise; no informal partnership; no prior assignment;
no other known agreement affecting ownership. `operator_attested` only —
professional review must confirm.

## 12. Current chain-of-title conclusion

- The operator declares Nova is intended to be personally owned.
- The operator declares they are the sole human contributor.
- No conflicting agreement or third-party contribution is currently known.
- Repository history and operator statements are broadly consistent with
  this position.
- **Legal ownership and transferability are not independently verified.**
- **R-01 remains open** until sufficient documentary/professional evidence
  exists.

## 13. Evidence still required (private; never committed)

- Exact legal identity of the owner.
- Private signed authorship/ownership statement.
- Relevant company formation dates (context only).
- Private confirmation that Stravos claims no Nova ownership, if
  professional review recommends it.
- GitHub account ownership proof; billing/account ownership records.
- AI-provider account and terms records for the development period.
- Development timeline evidence; device/account history.
- Professional chain-of-title review memo.
- A future asset-purchase agreement only when an actual transaction exists.

None of these are drafted by this milestone.

## 14. Professional-review questions

1. What documentary package suffices to evidence personal chain of title
   for a solo, AI-assisted project?
2. How should AI-assisted portions be treated for copyright/ownership under
   each provider's terms in effect during development?
3. Is a confirmation from Stravos Enterprises LLC (that it claims no Nova
   ownership) advisable given the founder's dual role?
4. Do any implicit employer/fiduciary doctrines apply despite the attested
   absence of agreements?
5. What identity-consolidation step (if any) is needed for the two git
   identities to be treated as one legal author?
6. Trademark/name clearance for "Nova Context" before brand investment.

## 15. Closure criteria for R-01

R-01 can close only when ALL of the following exist (privately, referenced
here by status only):

1. Owner's legal identity documented and consistent with the attestation.
2. Signed authorship/ownership statement executed and stored privately.
3. Professional legal review of the chain-of-title package completed, incl.
   the AI-authorship and provider-terms questions.
4. Git-identity classification confirmed in that review.
5. Any review-recommended confirmations (e.g., from Stravos) obtained.

Until then R-01 stays **open at P0** — not because a competing claim is
considered likely (operator attestation lowers that estimate), but because
documentary diligence evidence remains incomplete, which alone can block an
acquisition.
