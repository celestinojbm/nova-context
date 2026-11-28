# FEATURE_MAP — nova-context

> Mapa de funcionalidades para agentes y humanos: **qué hace Nova Context,
> dónde vive cada cosa, qué tests la cubren y cómo verificarla** antes de
> entregar un cambio. Complementa a [README.md](README.md) y [HANDOFF.md](HANDOFF.md).
> Refleja `main`; las PRs de memoria M20b–M20g (pila #26–#35) añadirán filas
> nuevas al fusionarse.

## Cómo verificar (general)

```bash
pnpm install
pnpm db:up            # Postgres (pgvector) + Redis locales (infra/docker-compose.dev.yml)
pnpm db:migrate
pnpm build && pnpm typecheck
pnpm test             # unit (vitest en src/ de cada paquete)
pnpm test:integration # integración contra Postgres/Redis reales (services/*/test)
pnpm validate:pr      # el mismo gate que corre CI (check obligatorio "build-test")
```

El gate `tools/validation-gate` (`pnpm validate:pr`) ejecuta prerequisitos,
build, typecheck, unit, migrate e integration, y deja el reporte en
`artifacts/validation/`. Es el check obligatorio de `main`.

## Funcionalidades

### 1. Captura instantánea (Context Moments)
- **Archivos:** API `services/api/src/routes-m3.ts`, `services/api/src/app.ts`
  (`/v1/context/moments`), esquema `packages/schema/src/context-moment.ts`,
  motor `packages/context-engine/src/capture-mode.ts`, `consent.ts`.
- **Tests:** `services/api/test/integration/moments.test.ts`,
  `services/api/test/integration/m3.test.ts`, `packages/schema/src/context-moment.test.ts`,
  `packages/context-engine/src/consent-capture-mode.test.ts`.
- **Verificar:** `pnpm --filter @nova/api exec vitest run --dir test moments m3`.

### 2. Clientes de captura: extensión de navegador y browser-shell
- **Archivos:** `apps/extension/` (WXT: `entrypoints/background.ts`,
  `entrypoints/sidepanel/*`, `utils/{api,capture,consent,live,voice}.ts`),
  `apps/browser-shell/` (Electron spike: `src/{main,capture,api-client,settings}.ts`).
- **Tests:** `apps/extension/utils/api.test.ts`, `apps/extension/utils/capture.test.ts`,
  `apps/browser-shell/test/api-client.test.ts`, `apps/browser-shell/test/capture.test.ts`,
  `services/api/test/integration/browser-shell.test.ts`.
- **Verificar:** `pnpm --filter @nova/extension test` y `pnpm --filter @nova/extension build`
  (cargar `.output/` como extensión sin empaquetar en Chrome).

### 3. Modo Live (sesión acotada con respuestas en tiempo real)
- **Archivos:** `services/api/src/routes-m3.ts` (`/v1/live/answers`),
  `packages/context-engine/src/live-buffer.ts`, `packages/model-router/src/live/anthropic.ts`,
  `packages/schema/src/live.ts`, `apps/extension/entrypoints/sidepanel/LivePanel.tsx`.
- **Tests:** `packages/context-engine/src/live-buffer.test.ts`, `packages/model-router/src/live/live.test.ts`,
  `services/api/test/integration/m3.test.ts`.
- **Verificar:** `pnpm --filter @nova/context-engine test` y `pnpm --filter @nova/model-router test`.

### 4. Intención, transcripción y enriquecimiento (model router)
- **Archivos:** `packages/model-router/src/` (`intent/{heuristic,router,anthropic}.ts`,
  `transcription/{router,openai}.ts`, `enrichment/anthropic.ts`, `embedding/openai.ts`, `types.ts`),
  `services/api/src/routes-m1.ts` (`/v1/transcriptions`), worker `services/worker/src/enrich.ts`,
  `packages/context-engine/src/local-enrichment.ts`.
- **Tests:** `packages/model-router/src/router.test.ts`, `packages/model-router/src/intent/heuristic.test.ts`,
  `packages/context-engine/src/local-enrichment.test.ts`, `services/worker/test/integration/enrichment.test.ts`,
  `services/api/test/integration/m1.test.ts`.
- **Verificar:** `pnpm --filter @nova/model-router test`; integración del worker con `pnpm test:integration`.

### 5. Redacción de PII y redacción visual (OCR) — fail-closed
- **Archivos:** `packages/context-engine/src/redaction.ts`, `visual-redaction.ts`, `media-gate.ts`,
  `services/api/src/image-redaction.ts`, `services/api/src/ocr.ts`.
- **Tests:** `packages/context-engine/src/redaction.test.ts`, `visual-redaction.test.ts`,
  `visual-redaction-coverage.test.ts`, `services/api/src/ocr.test.ts`,
  `services/api/src/image-redaction-coverage.test.ts`,
  `services/api/test/integration/visual-redaction.test.ts`, `m19a-redaction-persistence.test.ts`,
  `m19a-visual-redaction-ocr.test.ts`, `ocr-e2e.test.ts`.
- **Verificar:** `pnpm --filter @nova/context-engine test`; `pnpm test:integration` (suites `visual-redaction`, `m19a-*`).

### 6. Memoria: búsqueda y hechos extraídos (M2 + M20a)
- **Archivos:** `services/api/src/routes-m2.ts` (`/v1/memory/search`, proyectos, acciones),
  worker `services/worker/src/memory/{fact-extractor,write-facts}.ts` (extractor heurístico +
  filtro PII para capturas `skipped`), migración `services/api/migrations/0013_m20a_memory_facts.sql`,
  `packages/schema/src/search.ts`.
- **Tests:** `services/api/test/integration/m2.test.ts`, `search-golden.test.ts`,
  `services/worker/src/memory/fact-extractor.test.ts`, `services/worker/src/memory/pii-skipped.test.ts`,
  `services/worker/test/integration/m20a-memory-facts.test.ts`.
- **Verificar:** `pnpm --filter @nova/worker test`; `pnpm test:integration` (suites `m2`, `search-golden`, `m20a-memory-facts`).
- **M20h (opt-in):** `PATCH /v1/namespaces/:slug/memory/:id` serializa escrituras concurrentes del mismo
  ítem con su bloqueo de fila cuando `NOVA_MEMORY_ITEM_LOCK=on`; si la espera supera
  `NOVA_MEMORY_ITEM_LOCK_TIMEOUT_MS` (5000 por defecto) responde `429 item_busy` + `Retry-After`.
  Apagado por defecto (comportamiento histórico). Código: `services/api/src/routes-namespaces.ts`, `env.ts`.
  Tests: `services/api/src/{env,routes-namespaces}.test.ts`, `services/api/test/integration/m20h-memory-item-lock.test.ts`.
  Protección del pool: las esperas hacen cola en memoria (`services/api/src/item-write-gate.ts`) antes de pedir
  conexión — como mucho 1 conexión por ítem y la mitad del pool en total por proceso; espera en cola, en el
  pool y en el bloqueo comparten un único plazo (→ 429). Tests: `item-write-gate.test.ts` y el bloque
  "pool protection" del test de integración.
- **M20 búsqueda (`GET …/memory?q=`):** una consulta sin términos buscables (tokens de 1 carácter o solo
  signos: `a`, `?`, `a b`) responde 200 con `items: []` sin consultar Postgres; antes generaba un tsquery
  inválido (500). `q` solo con espacios equivale a no pasar `q`. Tests: `test/integration/m20-memory-fts.test.ts`.

### 7. Proyectos y tareas
- **Archivos:** `services/api/src/routes-m1.ts` (`/v1/tasks`, proyectos), `routes-m2.ts`, `routes-m4.ts`,
  `services/api/src/routes-project-write.ts` (`POST /v1/projects`, `PATCH /v1/context/moments/:id`:
  crear proyecto, confirmar/cambiar/desvincular proyecto y editar la intención con redacción),
  `packages/context-engine/src/suggest.ts` (`/v1/projects/suggest`),
  `packages/schema/src/{project,project-write,task,context-moment}.ts` (`listMomentsQuerySchema`),
  web `apps/web/app/{page,projects,tasks}/`.
- **Vínculo en la revisión:** `GET /v1/context/moments?link=unlinked|linked` y el mismo campo
  opcional en `POST /v1/memory/search`. Ausente, el listado y la búsqueda no filtran por vínculo
  (comportamiento histórico). No se combina con `project_id` (400). La web crea proyectos
  (`POST /v1/projects`) y confirma o quita el vínculo desde la timeline (`PATCH`).
- **Tests:** `services/api/test/integration/m1.test.ts`, `m4.test.ts`, `isolation.test.ts`,
  `project-write.test.ts`, `moment-link-filter.test.ts`,
  `packages/schema/src/{project-write,moment-link}.test.ts`.
- **Verificar:** `pnpm test:integration` (suites `m1`, `m4`, `isolation`, `project-write`, `moment-link-filter`).

### 8. Acciones con aprobación humana (risk tiers)
- **Archivos:** `services/api/src/routes-m2.ts`, `routes-integrations.ts` (`/v1/actions`, preview,
  approve/reject), worker `services/worker/src/actions.ts`, `packages/schema/src/action.ts`,
  adaptadores `services/api/src/adapters/{nova-task,notion,types}.ts`, web `apps/web/app/approvals/`.
- **Tests:** `services/worker/test/integration/actions.test.ts`, `services/api/test/integration/m2.test.ts`.
- **Verificar:** `pnpm test:integration` (suite `actions`).

### 9. Integración Notion (OAuth, destinos, media)
- **Archivos:** `services/api/src/routes-integrations.ts`, `services/api/src/integrations/notion-{oauth,api}.ts`,
  `services/api/src/adapters/notion.ts`, `packages/context-engine/src/notion-{mapping,page}.ts`,
  `services/worker/src/notion-client.ts`, web `apps/web/app/integrations/notion/`.
- **Tests:** `packages/context-engine/src/notion-mapping.test.ts`,
  `services/api/test/integration/notion.test.ts`, `notion-destinations.test.ts`, `notion-media.test.ts`,
  `services/worker/test/integration/notion-live-smoke.test.ts` (solo con credenciales reales; se omite sin ellas).
- **Verificar:** `pnpm test:integration` (suites `notion*`).

### 10. Media: almacenamiento cifrado, uso, limpieza y rotación de clave
- **Archivos:** `services/api/src/routes-media.ts`, `services/api/src/media/{media-service,object-store,cleanup}.ts`,
  `services/api/src/legacy-media.ts`, `packages/context-engine/src/{secret-box,object-store,data-url}.ts`,
  `services/worker/src/media-reader.ts`, scripts `services/api/src/db/{backfill-media,cleanup-media,rotate-media-key}.ts`.
- **Tests:** `packages/context-engine/src/secret-box.test.ts`, `data-url.test.ts`, `services/api/src/legacy-media.test.ts`,
  `services/api/test/integration/{media,media-ops,backfill-media,rotate-key,multi-key,m15b-legacy-media}.test.ts`.
- **Verificar:** `pnpm test:integration` (suites `media*`, `rotate-key`, `multi-key`).

### 11. Autenticación, sesiones, emparejamiento de la extensión y rate limit
- **Archivos:** `services/api/src/routes-auth.ts`, `services/api/src/auth/{plugin,sessions,passwords,rate-limit}.ts`,
  `packages/schema/src/auth.ts`, web `apps/web/app/{login,reset,settings}/`, `apps/web/app/api/pairing/route.ts`,
  `apps/web/middleware.ts`, `apps/extension/entrypoints/sidepanel/Connect.tsx`.
- **Tests:** `services/api/src/auth/passwords.test.ts`, `services/api/src/auth/rate-limit.test.ts`,
  `services/api/test/integration/{auth,auth-hardening,password-reset,security,isolation}.test.ts`.
- **Verificar:** `pnpm test:integration` (suites `auth*`, `password-reset`, `security`).

### 12. Cuenta del usuario: export completo y borrado completo
- **Archivos:** `services/api/src/routes-account.ts` (`/v1/export/account`, `/v1/auth/account/delete`),
  `services/api/src/routes-m3.ts` (`/v1/export`), web `apps/web/app/export/`.
- **Tests:** `services/api/test/integration/account-lifecycle.test.ts`, `m3.test.ts`.
- **Verificar:** `pnpm test:integration` (suite `account-lifecycle`).

### 13. Alpha: feedback, eventos de producto, auditoría y analítica
- **Archivos:** `services/api/src/routes-feedback.ts`, `routes-m4.ts` (`/v1/events`, `/v1/audit`),
  `services/api/src/analytics.ts`, `packages/schema/src/feedback.ts`, web `apps/web/app/audit/`.
- **Tests:** `services/api/test/integration/{alpha-feedback,alpha-ops,alpha-blockers,m4}.test.ts`.
- **Verificar:** `pnpm test:integration` (suites `alpha-*`).
- **Alpha bar (ROADMAP Horizonte 2):** `ops:report` incluye `alpha_bar` con las cinco métricas
  numéricas del roadmap y su estado (`pass` / `fail` / `insufficient_data`, este último con menos de
  5 de muestra): usuarios activos (≥25), capturas/usuario/semana (>3), capturas vinculadas a un
  proyecto **distinto del Inbox** (>40 %), p75 captura→acción confirmada (<30 s, medido en servidor:
  no incluye el tiempo del cliente antes de llegar a la API) y retención en semana 4 (>50 %).
  Añade la prueba de falsación de la teoría: tasa de acción de capturas con y sin intención
  hablada; la tasa de recuperación sale `null` (`not_instrumented`) porque la búsqueda aún no
  registra qué capturas devuelve. Excluye cuentas sintéticas (`*@alpha.local`, `*@nova-validate.invalid`, `dev@nova.local`)
  salvo `--include-synthetic`. Solo cuentas y ratios, sin contenido. Código:
  `services/api/src/ops/alpha-bar.ts`. Tests: `services/api/src/ops/alpha-bar.test.ts`,
  `services/api/test/integration/alpha-bar.test.ts`.

### 14. Operación: health, readiness, estado, preflight, smoke, mantenimiento, heartbeat
- **Archivos:** `services/api/src/app.ts` (`/healthz`, `/readyz`), `routes-ops.ts` (`/v1/ops/status`),
  `services/api/src/ops/{preflight,smoke,maintenance,report}.ts`, `services/api/src/env.ts`,
  `services/worker/src/heartbeat.ts`, web `apps/web/app/status/`.
- **Tests:** `services/api/src/routes-ops.test.ts`, `services/api/src/env.test.ts`,
  `services/api/test/integration/{ops,smoke,m18a4-smoke-cleanup}.test.ts`,
  `services/worker/test/integration/heartbeat.test.ts`.
- **Verificar:** `pnpm --filter @nova/api ops:preflight` y `ops:smoke` contra el entorno local.

### 15. Backup cifrado, restauración guardada y recuperación S3
- **Archivos:** `scripts/backup.sh`, `scripts/restore.sh`, `services/api/src/backup/*`
  (`crypto`, `manifest`, `sealed-backup-s3`, `media-s3`, `target`, `sanitize`, `run-*`).
- **Tests:** `services/api/src/backup/*.test.ts`, `services/api/test/integration/{m15b-backup-cli,m15c-seal-guard,m16-restore-guard,m18-media-recovery-s3,m18a-backup-sh,m18a2-sealed-backup-s3,m18a3-recovery-e2e,m18a3-restore-guard,m18a3-unseal-file}.test.ts`,
  `tools/validation-gate/test/m18a-recovery-s3.test.ts`.
- **Verificar:** `pnpm validate:recovery` (local, con S3 de prueba según `ci.yml`).

### 16. Gate de validación y despliegue
- **Archivos:** `tools/validation-gate/src/` (`cli.ts`, `runner.ts`, `checks/`, `outcome.ts`, `evidence.ts`,
  `sanitization.ts`, `recovery-remote.ts`, `report/`), `infra/deploy/*`, `infra/DEPLOY.md`.
- **Tests:** `tools/validation-gate/test/*.test.ts`.
- **Verificar:** `pnpm --filter @nova/validation-gate test`; `pnpm validate:pr`.

### 17. Web (cliente de referencia)
- **Archivos:** `apps/web/app/` (inicio con filtro y vínculo de proyecto, proyectos con alta,
  tareas, aprobaciones, auditoría, ajustes, estado, export, login).
- **Tests:** sin tests propios de la UI; el contrato que usa está en `moment-link-filter.test.ts`
  y `project-write.test.ts`. El resto, `pnpm build`/`pnpm typecheck`.
- **Verificar:** `pnpm --filter @nova/web dev` → abrir `http://localhost:3000`.

## Mantener este mapa

- Al añadir una funcionalidad, ruta o suite nueva, actualiza su fila aquí en la misma PR.
- Si una funcionalidad no tiene tests, dilo explícitamente (como en §17) en vez de omitirla.
