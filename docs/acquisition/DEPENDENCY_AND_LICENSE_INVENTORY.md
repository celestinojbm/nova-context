# Dependency & License Inventory — baseline `74ac864c` (2026-07-16)

Method: workspace `package.json` manifests + `pnpm-lock.yaml` +
`pnpm licenses list --prod` (command succeeded; 212 production packages
enumerated). **Engineering observations only — license interpretations
require professional review.** No new tooling was added to produce this.

## Production license distribution (transitive, from `pnpm licenses list --prod`)

| License | Packages | Note |
|---|---|---|
| MIT | 159 | permissive |
| Apache-2.0 | 34 | permissive; attribution/NOTICE hygiene recommended |
| BSD-2/BSD-3 | 7 | permissive |
| ISC | 6 | permissive |
| 0BSD / Unlicense / BlueOak-1.0.0 / (MIT AND Zlib) | 4 | permissive |
| **LGPL-3.0-or-later** | **1** | `@img/sharp-libvips-linux-x64` (prebuilt libvips for sharp, transitive via Next.js image pipeline). Dynamically-linked prebuilt; commonly considered acceptable for services, **flag for professional review**; sharp is replaceable if required |
| **CC-BY-4.0** | **1** | `caniuse-lite` (browser-support data via Next/browserslist). Attribution obligation — cover in NOTICE |

No GPL/AGPL packages found in the production tree. Dev-only tooling
(turbo, vitest, tsx, typescript, WXT, electron) was not exhaustively
transitively reviewed — **gap: dev-tree transitive review not verified**
(command used: `pnpm licenses list --prod`; a `--dev` sweep is the follow-up).

## Direct runtime dependencies by workspace (role / replaceability / risk)

| Workspace | Dependency | License | Role | Replacement difficulty | Transfer risk |
|---|---|---|---|---|---|
| @nova/api | fastify (+ @fastify/cors, multipart) | MIT | HTTP server | medium | low |
| @nova/api | pg | MIT | Postgres client | low | low |
| @nova/api | bullmq + ioredis | MIT | queue | medium | low |
| @nova/api | tesseract.js | Apache-2.0 | OCR for visual redaction | medium (quality-sensitive) | low |
| @nova/api, @nova/context-engine | jimp | MIT | image decode/mask | low-medium | low |
| @nova/api, @nova/context-engine | @aws-sdk/client-s3 | Apache-2.0 | object storage | low (S3-compatible abstraction exists) | low |
| @nova/api, @nova/schema, @nova/worker, @nova/model-router | zod | MIT | contracts/validation | medium (pervasive) | low |
| @nova/worker | pino | MIT | structured logs | low | low |
| @nova/model-router | @anthropic-ai/sdk | MIT | LLM provider SDK | medium (provider-coupled features) | **medium** — provider terms/account (R-05) |
| @nova/web | next, react, react-dom | MIT | web app | high (framework) | low (OSS) |
| @nova/extension | react, react-dom (+ WXT dev-time) | MIT | extension UI | medium | low |
| @nova/browser-shell | electron (dev) | MIT (Chromium: BSD-like + bundled licenses) | spike only | n/a (not shipped) | low |
| @nova/validation-gate | (none runtime) | — | tooling | — | — |

## Platform / external services (not npm)

| Item | License/terms | Note |
|---|---|---|
| PostgreSQL + pgvector | PostgreSQL License (permissive) | core store; portable |
| Redis | RSALv2/SSPL (server; client ioredis MIT) | service dependency, swappable hosting; terms review at transfer |
| Tesseract `eng.traineddata` | Apache-2.0 (tesseract-ocr project) | vendored data file |
| Electron/Chromium | MIT + Chromium bundle | M12 spike only, not in the product path |
| Fly.io, S3-compatible storage | provider ToS | account transferability = R-05, professional review |
| Anthropic / OpenAI / Notion APIs | provider terms | OFF by default at first deploy; usage/IP terms need professional review before enabling for real users |
| Icons/images/sample fixtures | none third-party found (fixtures generated in-test) | verified to inspection depth |

## Confidence & gaps

- **Verified:** direct deps per manifest; prod transitive license IDs as
  reported by pnpm.
- **Not verified:** dev-tree transitive licenses; license-text accuracy vs.
  package metadata; obligations analysis (professional review required).
- **Action items:** NOTICE file (Apache-2.0/CC-BY attribution), professional
  review of LGPL prebuilt + Redis server terms + model-provider terms at
  transfer/enablement time.
