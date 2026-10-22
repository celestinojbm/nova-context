# Diseño M20 (borrador): consolidación de memoria, namespaces y evaluación de calidad

> Estado: **borrador para discusión**. Solo documentación; no cambia código, esquema ni despliegue.
> Origen: notas de vigilancia de competidores del 22-oct-2026. Las afirmaciones sobre competidores se
> marcan **(por verificar)**: no se confirmaron contra fuentes primarias en este borrador.
> Prioridad: detrás de la demo M19 (bucle básico local). Nada aquí entra antes de cerrar M19.

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
3. **Casi duplicados**: candidatos por FTS (`ts_rank`) y, si hay vectores del **mismo `model`**, coseno ≥ umbral
   (p. ej. 0,92, a calibrar con §3). Sin embeddings: trigramas/Jaccard sobre texto normalizado.
4. **Contradicciones**: entre pares del mismo sujeto (misma entidad vía `entity_mentions`) con similitud media:
   reglas (negación, valores numéricos/fechas distintos para el mismo atributo); opcional NLI local.
   Se registra en `memory_conflicts`; el más reciente por `valid_from` queda `active`, el anterior `superseded`
   (`supersedes_id`). Si `author='user'` en cualquiera de los dos → no se resuelve automáticamente (`contested`).
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
- Namespaces `assistant`: memoria escrita/leída por una IA conectada por API; los tokens de API se limitan
  a una lista de namespaces (lectura/escritura). `local_only` del proyecto se hereda (no se exporta a la nube).
- La consolidación (§1) nunca fusiona entre namespaces.

### 2.2 API (prefijo `/v1`, mismo esquema de auth que hoy)
- `GET/POST /v1/namespaces`, `PATCH/DELETE /v1/namespaces/:slug` (delete = archivar; borrar duro solo vía cuenta).
- `GET /v1/namespaces/:slug/memory?q=&status=active&format=json|markdown`
- `POST /v1/namespaces/:slug/memory` (author=`assistant`/`user`), `GET /v1/memory/:id/history` (cadena `supersedes`).
- `GET /v1/export/namespace/:slug.md` y `GET /v1/export/account?format=markdown` (zip de un `.md` por namespace).
  Se registran en `audit_log` igual que el export JSON actual.

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

**Propuesta:** empezar con **LongMemEval** (subconjunto pequeño), porque sus categorías de
"actualización de conocimiento" y "razonamiento temporal" miden justo §1. Revisar FrontierMemory cuando se verifique.

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
- Embeddings opcionales con un modelo local (p. ej. vía Ollama/`transformers.js`) — requiere ampliar
  `@nova/model-router` y una columna `model` distinta; dimensión ≠ 1536 implica otra tabla/índice **(decisión)**.
- Script `pnpm eval:memory` fuera de la CI por defecto (CI solo corre el set propio de 50 casos).

## 4. Fases sugeridas
1. M20a: extractor de hechos → `memory_items` + `memory_item_sources` (detrás de flag).
2. M20b: namespaces + export Markdown (valor visible, bajo riesgo).
3. M20c: consolidación en dry-run + set propio de evaluación.
4. M20d: LongMemEval local; activar `apply` si las métricas lo justifican.

## 5. Decisiones abiertas
- ¿Entra M20 tras la demo M19 o espera a Dona/Fluvia?
- ¿Embeddings locales (otra dimensión) o FTS/trigramas sin vectores para la versión sin gasto?
- Política de conflicto por defecto: `newer_wins` automático o siempre `contested` hasta revisión del usuario.
- ¿Namespaces de asistente con tokens por namespace desde el inicio o solo por proyecto?
- LongMemEval vs. FrontierMemory tras verificar licencia y si requieren juez LLM.
