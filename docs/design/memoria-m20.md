# Diseño M20 (borrador): consolidación de memoria, namespaces y evaluación de calidad

> Estado: **borrador para discusión**. Solo documentación; no cambia código, esquema ni despliegue.
> §7 (24-nov-2026, aprobado por Celestino): reglas de captura por namespace. También solo diseño.
> Origen: notas de vigilancia de competidores del 22-oct-2026. Las afirmaciones sobre competidores se
> marcan **(por verificar)**: no se confirmaron contra fuentes primarias en este borrador.
> Prioridad: **en paralelo con M19** (decisión tomada, ver §5). Sin gasto ni despliegue.

## 0. Punto de partida en el código actual (verificado en `main`)

- `context_moments` (`services/api/migrations/0000_init.sql`): unidad atómica; `user_id`, `project_id`,
  `source_mode`, `extracted_text`, `intent_text`, `summary`, `captured_at`, `tsv` (FTS), `redaction_state`.
- `memory_items`: existe (`layer` = working|session|project|semantic|long_term, `content`, `metadata`)
  pero **ningún servicio inserta filas todavía** (sin `INSERT INTO memory_items` en `services/` ni `packages/`).
- `embeddings`: polimórfica (`owner_kind` moment|memory_item), `vector(1536)`, índice ivfflat, columna `model`.
- `entities` / `entity_mentions`: dedupe por `(user_id, kind, normalized)`.
- `enrichment_versions` (M10): precedente de versionado sin sobrescribir historia.
- `ops_maintenance_runs` (M11): precedente de trabajos de mantenimiento con `dry-run|apply` y reporte solo de conteos.
- Worker (`services/worker`): BullMQ sobre Redis; colas `moment-enrichment` y de acciones. El enriquecimiento
  degrada a heurísticas locales sin `ANTHROPIC_API_KEY`, y sin `OPENAI_API_KEY` no genera vectores.
- `docs/MEMORY_ENGINE.md` §2.7 y §5 ya describen "consolidation jobs — Nova's sleep" y versionado con `supersedes`;
  este borrador lo aterriza.
- Export existente: `GET /v1/export/account` (JSON completo, auditado en `audit_log`).

## 1. Consolidación de memoria en segundo plano

Referencia: Databricks Agent Memory (beta, ~20-oct) con un proceso en segundo plano ("dreaming") que consolida
memorias; reportan 3x de tasa de éxito con 31 % menos tokens en pruebas internas **(por verificar)**.

### 1.1 Requisito previo
Como `memory_items` está vacía, M20 necesita primero un **extractor de hechos**: el enriquecimiento escribe
0..N hechos `layer='semantic'` por momento (heurística local o LLM si está habilitado), con `moment_id` de origen.

### 1.2 Esquema (migración propuesta `0013_m20_memory_consolidation.sql`)
```sql
ALTER TABLE memory_items
  ADD COLUMN namespace_id   uuid REFERENCES memory_namespaces(id) ON DELETE CASCADE, -- ver §2
  ADD COLUMN status         text NOT NULL DEFAULT 'active', -- active|merged|superseded|contested
  ADD COLUMN canonical_id   uuid REFERENCES memory_items(id),  -- soft-merge: apunta al representante
  ADD COLUMN supersedes_id  uuid REFERENCES memory_items(id),  -- versión anterior
  ADD COLUMN valid_from     timestamptz,                       -- = captured_at del momento origen
  ADD COLUMN author         text NOT NULL DEFAULT 'model',     -- model|user (user nunca se toca)
  ADD COLUMN content_hash   text;                              -- sha256(normalizado)

CREATE TABLE memory_item_sources (          -- N momentos respaldan un hecho consolidado
  memory_item_id uuid REFERENCES memory_items(id) ON DELETE CASCADE,
  moment_id      uuid REFERENCES context_moments(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_item_id, moment_id));

CREATE TABLE memory_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  older_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  newer_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  detected_by text NOT NULL,               -- 'rule'|'nli-local'|'llm'
  resolution text NOT NULL DEFAULT 'open', -- open|newer_wins|user_resolved|false_positive
  run_id uuid, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE memory_consolidation_runs (   -- como ops_maintenance_runs: solo conteos
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, mode text NOT NULL, -- dry-run|apply
  report jsonb NOT NULL DEFAULT '{}', started_at timestamptz DEFAULT now(), finished_at timestamptz);
```
Nada se borra: un duplicado pasa a `status='merged'` con `canonical_id`; un hecho contradicho pasa a
`superseded` (o `contested` si no hay regla de fecha clara). Deshacer = revertir estados por `run_id`.

### 1.3 Algoritmo (cola nueva `memory-consolidation`, job repetible BullMQ nocturno por usuario)
1. **Selección**: ítems `active` creados/modificados desde la última corrida, agrupados por `user_id` y `namespace_id`.
2. **Duplicados exactos**: mismo `content_hash` → el más antiguo es canónico; el resto `merged`; se unen fuentes.
3. **Casi duplicados** (decidido: **primero texto**): candidatos por FTS (`ts_rank`) + trigramas (`pg_trgm`,
   `similarity()` ≥ umbral a calibrar con §3). Fase posterior: embeddings locales del **mismo `model`**, coseno ≥ umbral.
4. **Contradicciones**: entre pares del mismo sujeto (misma entidad vía `entity_mentions`) con similitud media:
   reglas (negación, valores numéricos/fechas distintos para el mismo atributo); opcional NLI local.
   **Política decidida: `newer_wins` automático.** Se registra en `memory_conflicts` con `resolution='newer_wins'`;
   el más reciente por `valid_from` queda `active` y el anterior pasa a `superseded` (`supersedes_id`), **sin borrarse**.
   Es reversible: `POST /v1/memory/:id/restore` o revertir por `run_id` reactiva el anterior y marca el conflicto
   `user_resolved`. Excepción: si `author='user'` en cualquiera de los dos → `contested` (no se toca lo del usuario).
5. **Reporte**: conteos en `memory_consolidation_runs`; por defecto `dry-run` hasta validar en alpha.
Idempotente (bloqueo por usuario con `pg_advisory_xact_lock`), por lotes, sin LLM por defecto.

### 1.4 Riesgos
- Falsos positivos de fusión (dos hechos parecidos pero distintos) → umbral conservador, dry-run, reversible por `run_id`.
- "El más nuevo gana" no siempre es correcto (cita antigua capturada hoy) → usar `captured_at` y marcar `contested`.
- Privacidad: el job no debe leer texto previo a redacción (`redaction_state='pending'` excluido) ni enviar a LLM
  externo sin `NOVA_CLOUD_ENRICHMENT=auto`; respetar `projects.local_only`.
- Borrado de cuenta/momento: las FK en cascada deben cubrir las tablas nuevas (verificar con los tests de M10).
- Coste/latencia de ivfflat con muchos usuarios; mezcla de vectores de modelos distintos (filtrar por `model`).
- Afirmaciones de rendimiento de Databricks no son transferibles; medir con §3.

## 2. Namespaces y exportación a Markdown

Referencia: Supermemory API v5 con respuestas más simples, salida Markdown y namespaces **(por verificar)**.

### 2.1 Modelo de datos
```sql
CREATE TABLE memory_namespaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,                        -- 'proyecto/dona', 'asistente/claude', 'default'
  kind text NOT NULL,                        -- 'project'|'assistant'|'custom'
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug));
```
- Cada usuario tiene `default`; cada `project` obtiene un namespace `project` (backfill en la migración).
- Namespaces `assistant`: memoria escrita/leída por una IA conectada por API, con **tokens por namespace desde
  el inicio** (decisión tomada; ver §2.4). `local_only` del proyecto se hereda (no se exporta a la nube).
- La consolidación (§1) nunca fusiona entre namespaces.

### 2.2 API (prefijo `/v1`, mismo esquema de auth que hoy)
- `GET/POST /v1/namespaces`, `PATCH/DELETE /v1/namespaces/:slug` (delete = archivar; borrar duro solo vía cuenta).
- `GET /v1/namespaces/:slug/memory?q=&status=active&format=json|markdown`
- `POST /v1/namespaces/:slug/memory` (author=`assistant`/`user`), `GET /v1/memory/:id/history` (cadena `supersedes`).
- `GET /v1/export/namespace/:slug.md` y `GET /v1/export/account?format=markdown` (zip de un `.md` por namespace).
  Se registran en `audit_log` igual que el export JSON actual.

### 2.4 Tokens por namespace para asistentes
```sql
CREATE TABLE namespace_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,                       -- 'claude-desktop', 'grok-bot'
  token_hash text NOT NULL UNIQUE,           -- sha256; el token en claro solo se muestra al crearlo
  token_prefix text NOT NULL,                -- 'nvx_ab12' para identificarlo en la UI/logs
  expires_at timestamptz,                    -- opcional; recomendado 90 días
  revoked_at timestamptz, last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE namespace_token_grants (
  token_id uuid REFERENCES namespace_tokens(id) ON DELETE CASCADE,
  namespace_id uuid REFERENCES memory_namespaces(id) ON DELETE CASCADE,
  scopes text[] NOT NULL,                    -- subconjunto de {memory:read, memory:write, memory:export}
  PRIMARY KEY (token_id, namespace_id));
```
- **Scopes**: `memory:read` (buscar/listar), `memory:write` (crear hechos con `author='assistant'`; nunca editar
  ni resolver hechos `author='user'`), `memory:export` (Markdown del namespace). Sin scope de cuenta: un token de
  namespace no puede tocar momentos, proyectos ni otros namespaces (404, no 403, para no filtrar existencia).
- **Emisión**: solo el usuario autenticado (`POST /v1/namespace-tokens`), eligiendo namespaces y scopes.
- **Revocación**: `DELETE /v1/namespace-tokens/:id` fija `revoked_at` con efecto inmediato (la validación consulta
  la BD/caché con TTL ≤ 60 s); borrar un namespace revoca sus grants en cascada; rotación = crear nuevo + revocar.
- **Auditoría**: cada uso escribe en `audit_log` (`actor='token:<prefix>'`, namespace, acción, conteo de ítems,
  sin contenido); emisión y revocación también se auditan. `last_used_at` visible en la UI.
- Límite de tasa por token; los namespaces `local_only` rechazan `memory:export` hacia destinos en la nube.

### 2.3 Formato Markdown de exportación
```markdown
---
namespace: proyecto/nova-context
exported_at: 2026-10-22T11:00:00Z
items: 42
format: nova-memory-md/v1
---
# proyecto/nova-context

## Hechos activos
- Prefiere asientos de pasillo. <!-- id:8f1c… valid_from:2026-03-02 author:model -->
  - Fuentes: [momento 811](nova://moment/811), [momento 902](nova://moment/902)

## Reemplazados
- ~~La demo es el 30-oct~~ → reemplazado por «La demo es el 6-nov» (2026-10-20)

## En conflicto (pendiente de revisar)
- «Precio 49 $» vs «Precio 59 $» — capturados 2026-09-01 y 2026-10-01
```
Reglas: sin medios ni texto sin redactar; ids en comentarios HTML para reimportación; ordenado por fecha.

## 3. Evaluación de calidad

### 3.1 Elección
| | LongMemEval | FrontierMemory 1.0 (Letta) |
|---|---|---|
| Madurez | Publicado 2024 (ICLR 2025), datos abiertos **(por verificar licencia)** | Anunciado 2026 **(por verificar contenido, licencia y si exige LLM juez de pago)** |
| Cubre | extracción, razonamiento multisesión y temporal, actualización de conocimiento, abstención **(por verificar)** | **(por verificar)** |

**Decidido:** **subconjunto local de LongMemEval + 50 casos sintéticos propios, sin juez de pago**. Sus categorías de
"actualización de conocimiento" y "razonamiento temporal" miden justo §1. FrontierMemory se añade en **M20d solo si es
gratuito y su licencia lo permite**; si exige un juez LLM de pago, queda fuera.

### 3.2 Adaptación
- Convertir cada sesión de chat del benchmark en `context_moments` sintéticos (`source_mode='instant_capture'`,
  `extracted_text` = turnos, `captured_at` = fecha de la sesión) en una base local de Docker (`scripts/` de M19).
- Correr enriquecimiento local + consolidación (§1) y luego responder cada pregunta con la búsqueda de Nova.
- Además: un **conjunto propio pequeño** (~50 casos) de duplicados/contradicciones sintéticos con verdad conocida.

### 3.3 Métricas (sin LLM)
- Recuperación: Recall@k y MRR de los momentos/hechos de evidencia (las preguntas traen ids de evidencia **(por verificar)**).
- Consolidación: precisión/recall de fusiones y de conflictos detectados vs. etiquetas; % hechos "vigentes" correctos.
- Exactitud de respuesta: coincidencia exacta/F1 de tokens con la respuesta de referencia (aproximado; sin juez LLM).
- Coste: tokens/consulta (0 en modo local), latencia p50/p95, tamaño del contexto devuelto.
- Comparar línea base (solo FTS sobre momentos) vs. con consolidación.

### 3.4 Ejecución sin gasto
- Todo local: Postgres+pgvector en Docker, sin `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (el worker ya degrada a heurísticas).
- Embeddings locales (fase posterior, p. ej. vía Ollama/`transformers.js`): requiere ampliar `@nova/model-router`
  y un valor `model` distinto; si la dimensión ≠ 1536 van en **tabla o índice aparte** (p. ej. `embeddings_local`),
  sin mezclar con `vector(1536)`.
- Script `pnpm eval:memory` fuera de la CI por defecto (CI solo corre el set propio de 50 casos).

## 4. Fases (ajustadas a las decisiones)
M20 avanza **en paralelo con M19**; cada fase en su PR, sin gasto ni despliegue.
1. **M20a**: extractor de hechos → `memory_items` + `memory_item_sources` (detrás de flag) + set de 50 casos sintéticos.
2. **M20b**: namespaces + tokens por namespace (scopes, revocación, auditoría) + export Markdown.
3. **M20c**: consolidación con FTS/trigramas; `newer_wins` reversible; dry-run por defecto; medir con los 50 casos.
4. **M20d**: subconjunto local de LongMemEval (sin juez de pago); FrontierMemory solo si es gratis y la licencia lo
   permite; activar `apply` si las métricas lo justifican.
5. **M20e** (posterior): embeddings locales en tabla/índice aparte si cambia la dimensión; comparar contra M20c.

## 5. Decisiones tomadas (Celestino, 22-oct-2026)
1. **Calendario**: M20 corre en paralelo con M19.
2. **Búsqueda**: primero texto (FTS + trigramas); embeddings locales después, en tabla o índice aparte si cambia la dimensión.
3. **Conflictos**: gana automáticamente el hecho más nuevo; el anterior queda `superseded` (reversible). Hechos del usuario → `contested`.
4. **Acceso de asistentes**: tokens por namespace desde el inicio, con scopes, revocación y auditoría (§2.4).
5. **Evaluación**: subconjunto local de LongMemEval + 50 casos sintéticos, sin juez de pago; FrontierMemory en M20d
   solo si es gratis y su licencia lo permite.

## 6. Pendiente
- Umbrales de similitud (trigramas/coseno): se calibran con §3.
- ~~Verificar licencia de LongMemEval y de FrontierMemory antes de descargar datos.~~ Verificado el 22-oct-2026 con fuentes primarias:
  - **LongMemEval** — código [MIT](https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE); datos
    [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) con `license:mit`,
    sin gating (el dataset original `longmemeval` está deprecado). **Uso gratuito permitido.**
    El script oficial de exactitud (`src/evaluation/evaluate_qa.py`) usa **GPT-4o como juez (de pago)** → no lo usamos.
    Sí sirven sin juez: `answer_session_ids` y `has_answer` por turno permiten Recall@k/MRR de sesión y de turno,
    más EM/F1 aproximado (§3.3). Ojo: las sesiones de relleno vienen de ShareGPT/UltraChat (licencias propias); solo
    uso local de evaluación, sin redistribuir los datos en el repo.
  - **FrontierMemory 1.0 (Letta, oct-2026)** — corpus
    [`letta-ai/frontier-memory-corpus`](https://huggingface.co/datasets/letta-ai/frontier-memory-corpus): etiqueta
    `license:cc-by-4.0`, pero **gated** (aceptar condiciones) con restricciones: solo evaluar memoria, no entrenar ni
    republicar fuera de un repo gated; cada benchmark de origen mantiene su licencia (`THIRD_PARTY_NOTICES.md`).
    No encontré repo público del paquete `frontier-memory` (p. ej. `github.com/letta-ai/frontier-memory` → 404), así que
    su licencia de código **sigue sin verificar**. Según [frontiermemory.com](https://www.frontiermemory.com/) y el
    [blog v1](https://www.frontiermemory.com/blog/v1/), no hay juez LLM, pero la **métrica exige agentes LLM**
    (generación de memoria + agente de tareas con Opus 5.5/GPT-6 Sol, ~0,77–4 USD por tarea) y mide aprendizaje desde
    trayectorias de código, no memoria personal. **Conclusión: no cumple "gratis"; queda fuera de M20d** salvo nueva
    decisión de Celestino.

## 7. Reglas de captura por namespace (`matched_by`)

Diseño solamente. No hay migración, ruta ni flag en este cambio. La implementación, cuando exista, va en un PR
posterior y nace apagada. Celestino aprobó redactar esta sección (24-nov-2026).

Hoy una captura no elige namespace. `POST /v1/context/moments` (`services/api/src/app.ts`) guarda el momento y, si
`NOVA_MEMORY_FACTS=on` (por defecto `off`), el worker llama a `writeMomentFacts`. Esa función asigna el namespace
vivo del proyecto del momento y, si no hay, `default` (`resolveNamespace` en
`services/worker/src/memory/write-facts.ts`). Esta sección añade reglas **por namespace** que pueden desviar o
suprimir solo esa asignación, y dejan constancia en `matched_by`. Sin reglas, o con la flag apagada, el camino de
arriba no cambia.

Las reglas no capturan solas. Sigue haciendo falta el gesto del usuario (consentimiento de la extensión,
`CONSENT_VERSION`). No hay captura en segundo plano.

### 7.1 Sintaxis y qué decide cada regla

La regla vive en un namespace y se edita ahí. **El namespace destino es ese namespace**: no hay un campo que apunte a
otro. Así una regla no puede sacar memoria de un proyecto hacia `asistente/…` o hacia `default` por un descuido del
JSON. Crear la regla debajo de `proyecto/<id>` es decidir el destino.

Cada regla decide tres cosas:

| Campo | Valores | Efecto |
|---|---|---|
| destino | el namespace de la ruta | `capture`: los hechos de ese momento van a este namespace |
| `effect` | `capture` \| `skip` | `skip`: no se escribe ningún `memory_item` de ese momento. El momento sí se guarda |
| `priority` | entero −1000…1000, default 0 | mayor gana |

`skip` no borra el momento, no salta la redacción y no toca `local_only`. `enabled` (default `true`) saca la regla de
la evaluación sin borrarla.

Los predicados presentes se combinan con **Y**. Hace falta al menos uno. No hay O dentro de una regla: eso son dos
reglas.

```json
{ "effect": "capture", "priority": 10, "match": { "url_host": "github.com", "url_path_prefix": "/celestinojbm/" } }
{ "effect": "skip",    "priority": 50, "match": { "source_mode": "live_context" } }
{ "effect": "capture", "priority": 20, "match": { "title": "standup*" } }
{ "effect": "capture", "priority": 5,  "match": { "text": "*factura*" } }
{ "effect": "capture", "priority": 30, "match": { "app": "nova-browser-shell" } }
```

- **URL / dominio.** `url_host` es un host en minúsculas (`github.com`, coincidencia exacta) o `*.github.com` (ese host
  y cualquier subdominio; `evilgithub.com` no coincide). `url_path_prefix` es opcional, empieza por `/` y exige host;
  `/docs` no coincide con `/docs-old`. Se comparan solo host y path. Query, fragmento y userinfo se tiran antes de
  comparar y no se guardan en la regla ni en la auditoría: una URL de captura puede llevar un token en la query.
- **Tipo de fuente.** `source_mode`: `instant_capture` o `live_context`, los dos valores de `sourceModeSchema`. No hay
  otros.
- **Título o texto.** Glob, no regex: solo literales y `*`, sin distinguir mayúsculas, sobre texto ya normalizado
  (NFKC). `title` mira `source_meta.title`. `text` acierta si el glob aparece en `intent_text` **o** en
  `extracted_text`. No mira `payload`, ni `ocr_text`, ni píxeles. Longitud máxima 200. Se rechaza `?`, `[`, `(`, `\`,
  `{` y cualquier otro metacarácter, para que no entre una regex con backtracking.
- **App.** Igualdad exacta, sensible a mayúsculas, contra `source_meta.app` (la extensión o
  `apps/browser-shell` mandan ese campo; el shell usa `nova-browser-shell`). Caracteres permitidos:
  letras, dígitos y `._:-`. Sin glob: `*` no puede seleccionar todas las apps.

Si falta el dato que el predicado exige (no hay URL, ni título, ni app), ese predicado no acierta. No se interpreta
como “coincide con todo”.

### 7.2 Orden de evaluación

Solo corre si `NOVA_CAPTURE_RULES=on`. Ocurre en la API, **después** de la redacción de texto y de la redacción visual,
y **antes** del `INSERT` del momento, para que la decisión y el momento queden en la misma escritura.

1. Cargar las reglas `enabled` del usuario cuyo namespace no está archivado (`archived_at` nulo). Tope de lectura: las
   200 del usuario.
2. Ordenar por `priority` descendente, luego por especificidad descendente (cuántos predicados tiene), luego por
   `updated_at` descendente, luego por `id` ascendente. El último desempate es estable y testeable.
3. Recorrer en ese orden. Una regla acierta cuando **todos** sus predicados aciertan.
4. Aplicar la guarda de §7.4. Si la guarda la rechaza, **no gana**: se sigue con la siguiente. No se anota
   `matched_by` por un intento rechazado.
5. La primera que acierta y pasa la guarda gana. Se deja de mirar.
6. Si ninguna gana, el comportamiento es el de hoy: `matched_by` queda nulo y `resolveNamespace` elige el namespace
   del proyecto o `default`.

La decisión se congela en el momento. Editar o borrar la regla después no reescribe momentos ni hechos ya escritos.
El worker, al extraer, obedece esa foto; no vuelve a evaluar reglas. Volver a enriquecer el mismo momento tampoco
re-evalúa (el índice único `(moment_id, content_hash)` de M20a sigue evitando duplicados).

`PATCH /v1/context/moments/:id` no dispara las reglas. Cambiar de proyecto sigue actualizando `memory_items.local_only`
como ahora (`routes-project-write.ts`) y no mueve `namespace_id`.

### 7.3 Tablas (solo aditivas) y dónde se guarda `matched_by`

Siguiente número libre después de `0018_m2_ingest_status.sql`:

`services/api/migrations/0019_m20i_namespace_capture_rules.sql`, con bajada manual en
`services/api/migrations/rollback/0019_m20i_namespace_capture_rules.down.sql` (misma convención que 0014–0017; el
runner solo avanza). No hay backfill: las filas viejas se quedan con NULL y siguen el camino actual.

```sql
CREATE TABLE namespace_capture_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace_id  uuid NOT NULL REFERENCES memory_namespaces(id) ON DELETE CASCADE,
  priority      integer NOT NULL DEFAULT 0,
  effect        text NOT NULL,                  -- capture | skip
  enabled       boolean NOT NULL DEFAULT true,
  match_url_host       text,
  match_url_path_prefix text,
  match_source_mode    text,                    -- instant_capture | live_context | NULL
  match_title          text,
  match_text           text,
  match_app            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT namespace_capture_rules_effect_chk CHECK (effect IN ('capture','skip')),
  CONSTRAINT namespace_capture_rules_priority_chk CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT namespace_capture_rules_source_mode_chk
    CHECK (match_source_mode IS NULL OR match_source_mode IN ('instant_capture','live_context')),
  CONSTRAINT namespace_capture_rules_match_chk CHECK (
    match_url_host IS NOT NULL OR match_url_path_prefix IS NOT NULL OR match_source_mode IS NOT NULL
    OR match_title IS NOT NULL OR match_text IS NOT NULL OR match_app IS NOT NULL),
  CONSTRAINT namespace_capture_rules_path_needs_host_chk
    CHECK (match_url_path_prefix IS NULL OR match_url_host IS NOT NULL)
);
CREATE INDEX idx_capture_rules_user_enabled
  ON namespace_capture_rules (user_id, priority DESC, updated_at DESC) WHERE enabled;

-- Foto de la decisión. Sin FK a propósito: borrar la regla no borra capturas ni blanquea la procedencia.
ALTER TABLE context_moments
  ADD COLUMN matched_by uuid,
  ADD COLUMN capture_rule_effect text,
  ADD COLUMN capture_rule_namespace_id uuid;
ALTER TABLE context_moments
  ADD CONSTRAINT context_moments_capture_rule_effect_chk
    CHECK (capture_rule_effect IS NULL OR capture_rule_effect IN ('capture','skip'));

ALTER TABLE memory_items
  ADD COLUMN matched_by uuid;
```

Límites de longitud en las mismas `CHECK`: host ≤ 253, path ≤ 512, título y texto ≤ 200, app ≤ 256.

- **Momento.** `matched_by` es el id de la regla que ganó. `capture_rule_effect` y `capture_rule_namespace_id` son la
  foto (`skip` o el namespace destino). Los tres quedan NULL si no ganó nadie o si la flag está apagada.
- **Hecho.** `memory_items.matched_by` copia el id **solo si** el hecho se escribió de verdad en el namespace de esa
  regla. Si la guarda de §7.4 impide ese destino en el momento de escribir, el hecho sigue el camino de hoy
  (`resolveNamespace`) y su `matched_by` queda NULL. El momento conserva la foto, así que se puede ver que la regla
  coincidió y que la guarda mandó más que ella.
- Borrar la regla borra la fila de `namespace_capture_rules` y nada más. El uuid en el momento y en el hecho puede
  quedar colgando. Es la procedencia, no una clave viva.
- Archivar un namespace no borra sus reglas. Dejan de evaluarse y dejan de verse en la API (el namespace archivado ya
  responde 404). Desarchivar, como hoy, las vuelve a dejar vigentes.
- Borrar la cuenta sigue cayendo en cascada desde `users`. No hace falta una tabla nueva en el export: las columnas
  viajan con el momento y con el hecho.
- La consolidación (§1) sigue sin fusionar entre namespaces. `matched_by` no es clave de fusión. `skip` no deja
  hechos que consolidar. Los hechos de esta vía nacen `author='model'`; una regla no crea ni edita hechos
  `author='user'` ni `author='assistant'`.
- M20h (`NOVA_MEMORY_ITEM_LOCK`, #40, apagado por defecto) serializa `PATCH` de un `memory_item`. Esta vía solo hace
  `INSERT` en la extracción. No toma ese bloqueo y no cambia el `PATCH`. Un reproceso futuro que actualice filas
  existentes tendría que tomarlo cuando la flag de M20h esté encendida, y no podría tocar hechos del usuario.

### 7.4 Redacción, PII con `skipped` y `local_only`

La regla **nunca afloja** una guarda que ya existe. Si una regla y una guarda discrepan, gana la guarda. De más fuerte
a más débil:

1. **La captura la pide el usuario.** La regla no crea momentos y no impide guardar el que el usuario acaba de pedir.
2. **Redacción en la captura** (`NOVA_REDACTION`, por defecto `on`). `redactDeep` corre sobre `extracted_text`,
   `intent_text`, `payload` y `source_meta.title` antes de sugerencias, almacenamiento, enriquecimiento, auditoría y
   reglas (`app.ts`). La regla no tiene un interruptor para saltársela. Los predicados de título y de texto ven solo
   el texto ya redactado. Un patrón que solo existía en el secreto (un email, una clave) no acierta, porque ese
   secreto ya es `[REDACTED:…]`.
3. **Redacción visual** (`NOVA_IMAGE_REDACTION`, estricta forzada en producción). Igual que hoy. Las reglas no ven
   píxeles ni cajas de OCR.
4. **`redaction_state` distinto de `applied` y de `skipped`.** `writeMomentFacts` no lee el momento y no escribe
   hechos (`skipped: 'redaction_pending'`). La regla no anula esa puerta. En la práctica el `POST` deja `applied` o
   `skipped`; `pending` es el default de la columna para filas que no pasan por esa ruta.
5. **Redacción `skipped` (#33, ya en `main`).** Con `NOVA_REDACTION=off` el momento guarda el texto en crudo y
   `redaction_state='skipped'`. Antes de extraer, `filterSkippedPii` vuelve a pasar los detectores de `redactText`
(email, teléfono, tarjeta con Luhn, `api_key`, SSN, IBAN). Esta sección usa **el mismo filtro antes de evaluar**
  `title` y `text`, sobre una copia: con `NOVA_REDACTION=off` el momento sigue guardando el texto en crudo, igual que
  hoy. El extractor (`heuristic-v1`) ya tira las frases con `[REDACTED…]`, `███` o `****`. La regla no
  puede marcar un momento como exento, ni guardar el texto previo al filtro en `matched_by`, en la regla o en
  `audit_log`.
6. **`local_only`.** Se hereda de `projects.local_only` hacia `memory_items.local_only` (M20a) y se refuerza al
   revincular el momento. Un token no lee, no edita y no exporta esos hechos; el Markdown tampoco
   (`routes-namespaces.ts`). La guarda de una regla `capture`:
   - `moment_local` = `local_only` del proyecto del momento (falso si no hay proyecto).
   - `target_local` = `local_only` del proyecto del namespace destino (falso en `default`, `assistant` y `custom`,
     que no tienen proyecto).
   - Si `moment_local` y no `target_local`, la regla **se rechaza** y se prueba la siguiente. No se mueven hechos a
     `default` ni a un namespace de asistente. Un token no gana así una lectura que hoy no tiene.
   - Si el destino es más estricto (`target_local` y el momento no), la regla sí puede: el hecho se guarda con
     `local_only = true`. Las reglas solo empujan hacia más restricción.
   - El hecho, si se escribe en el destino, queda `local_only = moment_local OR target_local`. Nunca se escribe
     `false` cuando alguno de los dos es `true`.
   - `skip` sobre un momento `local_only` está permitido: no publica nada, solo no crea hechos.
   - Segunda comprobación en `writeMomentFacts`, porque el worker es asíncrono y un `PATCH` puede cambiar el
     proyecto antes de extraer. Si en ese instante la foto mandaría un momento `local_only` a un namespace que no lo
     es, se ignora el destino y se usa `resolveNamespace`. `matched_by` del hecho queda NULL.
7. **Efecto de la regla** (`capture` o `skip`), ya con las guardas de arriba pasadas.
8. **Default.** Sin ganadora: `resolveNamespace`, `matched_by` NULL en el momento y en los hechos.

`NOVA_CLOUD_ENRICHMENT` no se toca. Una regla no añade llamadas a un modelo ni mete texto en el enriquecimiento. Que
el enriquecimiento en la nube, con la flag `auto` y una clave, hoy no mire `local_only`, queda fuera de esta sección:
las reglas no lo usan para ampliar ese camino. Ver la pregunta abierta en §7.8.

### 7.5 API, validación, auditoría y el default

Misma auth que el resto de namespaces: solo sesión de usuario. Un token `nvx_…` recibe **404** (estas rutas no entran
en `tokenRouteAllowed`). El slug ajeno, archivado o inexistente también es 404, como hoy, para no filtrar existencia.
El segmento `capture-rules` se reserva igual que `memory` (`RESERVED_SEGMENTS`), para que un namespace no se llame
así y choque con la ruta.

| Método | Ruta | Quién |
|---|---|---|
| GET | `/v1/namespaces/<slug>/capture-rules` | dueño, lista |
| POST | `/v1/namespaces/<slug>/capture-rules` | dueño, crea |
| PATCH | `/v1/namespaces/<slug>/capture-rules/<uuid>` | dueño, sustituye |
| DELETE | `/v1/namespaces/<slug>/capture-rules/<uuid>` | dueño, borra la regla |

Van en el comodín que ya usa `routes-namespaces.ts` (`/v1/namespaces/*`), reconocidas por el sufijo
`/capture-rules` antes que por `/memory`.

Validación (400 `invalid_rule`, con `issues[].path` y un `code`, **sin** devolver el texto enviado):

- `empty_match`, `bad_host`, `bad_glob`, `bad_path`, `path_without_host`, `bad_source_mode`, `bad_app`,
  `bad_priority`, `bad_effect`.
- Tope: 50 reglas por namespace y 200 por usuario → 409 `too_many_rules`.
- Un `PATCH` que trae `match` sustituye el bloque entero. No se mezclan predicados viejos con nuevos: un match
  parcial no puede dejar un host olvidado que siga acertando.

Auditoría, solo ids, en `audit_log` (el `detail` sigue sin payload y sin secretos):

- Eventos `capture_rule.create`, `capture_rule.update`, `capture_rule.delete`.
- `detail`: `rule_id`, `namespace_id`, `effect`, `priority`, `enabled`. Nada de host, path, título, texto, app ni
  contenido del momento.
- `subject_kind = 'capture_rule'`, `subject_id` = id de la regla.
- En el evento `capture` que ya existe, si una regla ganó se añaden solo `matched_by` y `effect`. Si la flag está
  apagada, esa fila de auditoría no gana campos.

**Sin reglas, el producto de hoy.** Tres casos equivalentes para el momento y para los hechos:

| | `matched_by` | namespace de los hechos | rutas nuevas |
|---|---|---|---|
| flag apagada (default) | NULL, ni se consulta la tabla | proyecto o `default` | 404 |
| flag encendida, cero reglas | NULL | igual | lista vacía |
| flag encendida, ninguna acierta o todas rechazadas por §7.4 | NULL | igual | — |

`NOVA_MEMORY_FACTS` sigue siendo otra flag, también apagada por defecto. Una regla de `capture` no enciende la
extracción. Con los hechos apagados, el momento guarda la foto y no se crean `memory_items` (igual que M20a hoy).
No hay backfill de momentos antiguos al encender las flags.

### 7.6 Plan de pruebas

Todo local. Sin claves de modelo, sin juez de pago, sin servicio nuevo. La suite entra en `pnpm test` /
`pnpm test:integration` y, en el PR de implementación, en `pnpm validate:pr`.

- **Matcher puro** (sin base de datos): host exacto, `*.github.com` contra un subdominio y contra `evilgithub.com`,
  path `/docs` contra `/docs-old`, query tirada antes de comparar, glob de título sin caso, glob de texto solo sobre
  la cadena ya redactada, `source_mode`, app exacta, Y de varios predicados, match vacío rechazado, orden de
  desempate, `*` suelto rechazado en app y en glob ilegal.
- **Guardas puras:** `local_only` hacia `default` o hacia un namespace de asistente se rechaza y gana la regla
  siguiente si esa sí es segura; `skip` sobre `local_only` se permite; un destino `local_only` fuerza
  `local_only=true` en el hecho; con `redaction_state='skipped'`, un patrón igual al email en crudo no acierta.
- **Integración, Postgres local:**
  - la 0019 aplica y el `.down.sql` solo quita esta tabla, este índice y estas columnas;
  - flag apagada: el `POST` deja `matched_by` NULL, el GET de reglas responde 404, y el namespace de los hechos sigue
    siendo el del proyecto o `default` (los tests de M20a no cambian de resultado);
  - flag encendida y sin reglas: mismo resultado;
  - regla de URL: el hecho queda en ese namespace y el momento y el hecho llevan el mismo `matched_by`;
  - regla `skip`: el momento existe, `redaction_state='applied'`, cero hechos, `matched_by` solo en el momento;
  - PII con redacción `skipped`: el test `pii-skipped` sigue en verde y ningún `memory_item` contiene el secreto;
  - proyecto `local_only` más regla en `default`: el hecho no sale del namespace del proyecto, `local_only` sigue
    true, un token no lo lista y el Markdown no lo exporta;
  - otro usuario y un token de namespace: 404;
  - el `detail` de auditoría tiene solo los ids y los campos de §7.5; el test falla si aparece el título, la URL o
    el texto;
  - `DELETE` de la regla no borra momento ni hecho, y `matched_by` se queda;
  - dos reglas que aciertan: gana la de mayor `priority`; a igualdad, la más específica;
  - la suite de M20h (`m20h-memory-item-lock`) sigue igual: esta vía no pasa por el `PATCH` bloqueado.
- El PR de documentación no añade tests ejecutables. No se enciende la flag en CI.

### 7.7 Flag y salida

`NOVA_CAPTURE_RULES=on|off` en `services/api/src/env.ts`, default **`off`**, y una línea en `securitySummary` junto a
`NOVA_MEMORY_ITEM_LOCK`. El worker no necesita su propia flag: si la API está apagada, las tres columnas nacen NULL y
`writeMomentFacts` hace lo de hoy.

Apagada, el evaluador no se llama y las rutas responden 404. Encenderla en local o en un alpha que nombre Celestino
no cambia el default del repo. Apagarla otra vez ignora las reglas guardadas al momento; no hace falta bajar la
migración para volver al comportamiento anterior. La bajada de esquema solo si se decide tirar las columnas, y eso
borra la procedencia.

Esta sección no reordena las fases de §4 ni M20h. Es posterior, y el primer PR de código que la implemente tiene que
dejar la flag apagada.

### 7.8 Preguntas abiertas para Celestino

1. **Destino.** Aquí el destino es el namespace donde vive la regla. ¿Hace falta que una regla nombre otro namespace
   del mismo usuario? Mientras no se diga, no existe ese campo: es el agujero por el que un `local_only` se iría a un
   asistente.
2. **`skip`.** ¿Basta con no escribir hechos, o `skip` debería poder no guardar el momento? La propuesta es guardar
   siempre el momento: la captura la pidió el usuario y el consentimiento no habla de reglas que la tiren.
3. **Cuándo se evalúa.** ¿Solo al crear el momento, o también en `PATCH` (proyecto o intención)? La propuesta es solo
   al crear: un cambio posterior no reescribe la historia. El `PATCH` sí sigue pudiendo poner `local_only` a true.
4. **Glob o regex.** La propuesta es glob. Una regex de usuario reabre backtracking sobre texto capturado.
5. **Topes.** 50 reglas por namespace y 200 por usuario. ¿Otros números?
6. **`matched_by` sin clave foránea.** Así borrar la regla no borra capturas ni pone el id a NULL. El id puede quedar
   colgando. ¿Preferible `ON DELETE SET NULL` y perder la procedencia?
7. **Qué texto compara `text`.** Propuesta: `intent_text` y `extracted_text` ya redactados. Fuera `payload` y
   `ocr_text`. ¿Hay que incluir alguno de esos dos?
8. **Enriquecimiento en la nube y `local_only`.** Con `NOVA_CLOUD_ENRICHMENT=auto` y clave, el worker puede mandar el
   texto del momento igual que hoy, sin mirar `local_only`. Esta sección no lo abre más y tampoco lo cierra. ¿Se
   cierra en otro diseño?
9. **Slug reservado.** ¿Se reserva el segmento `capture-rules` como ya se reserva `memory`? La propuesta es sí, para
   que la ruta no sea ambigua.
