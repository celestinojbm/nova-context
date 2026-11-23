# M20c — Calibración de la consolidación (casos sintéticos)

Fuente: `services/worker/eval/m20-synthetic-cases.json` (50 casos inventados). Los 10 casos de
`privacy_or_noise` producen menos de 2 hechos y no forman pares; quedan **40 pares** evaluables:
20 `merge` (10 exactos y 10 casi duplicados), 10 `newer_wins` y 10 `keep_both`.

Test reproducible: `M20C_PRINT=1 pnpm --filter @nova/worker exec vitest run src/memory/consolidation-calibration.test.ts`.
Sin embeddings, sin LLM y sin red: similitud de trigramas (`pg_trgm`, con réplica en JS verificada contra Postgres en
`test/integration/m20c-consolidation.test.ts`, diferencia < 0,02) más reglas de tokens.

## Reglas (`consolidation-rules.ts`)
1. **Merge**: mismos tokens de contenido (sin stopwords, con un léxico pequeño de canonicalización: números escritos,
   plurales, `repo→repositorio`, `lanzar→publicar`, `será→es`, `every/all`), o un conjunto de tokens contenido en el otro con similitud ≥ `mergeSubset`.
2. **Conflicto**: prefijo común que incluye un verbo o `clave:` (mismo sujeto y atributo), con valores distintos en
   ambos lados y similitud ≥ `conflict`. Gana el más nuevo (`valid_from`); el anterior pasa a `superseded`. Si hay un hecho con `author='user'`, el par queda `contested` y el conflicto `open`.
3. Pares con similitud < `candidate` (0,3) no se consideran.

## Umbrales elegidos
`candidate = 0.30`, `mergeSubset = 0.50`, `conflict = 0.45`.

| Relación | TP | FP | FN | Precisión | Recall |
|---|---|---|---|---|---|
| Merge | 20 | 0 | 0 | 1,00 | 1,00 |
| Conflicto | 10 | 0 | 0 | 1,00 | 1,00 |

## Barrido (precisión/recall)
| mergeSubset | conflict | P merge | R merge | P conflicto | R conflicto |
|---|---|---|---|---|---|
| 0.4–0.7 | 0.30 | 1.00 | 1.00 | 0.91 | 1.00 |
| 0.4–0.7 | 0.40 | 1.00 | 1.00 | 1.00 | 1.00 |
| 0.4–0.7 | 0.45 | 1.00 | 1.00 | 1.00 | 1.00 |
| 0.4–0.7 | 0.50 | 1.00 | 1.00 | 1.00 | 0.90 |
| 0.4–0.7 | 0.60 | 1.00 | 1.00 | 1.00 | 0.80 |
| 0.4–0.7 | 0.70 | 1.00 | 1.00 | 1.00 | 0.40 |

Con `conflict = 0.30` aparece un falso conflicto (`m20-031`, "Ana prefiere reuniones…" vs "Ana prefiere el té…").
Se elige 0,45, en el centro de la meseta 0,40–0,45.

## Limitaciones (importante)
- **Sobreajuste**: el léxico y las reglas se ajustaron con estos mismos 40 pares; el 1,00 no es una estimación
  de producción. Hace falta un conjunto de validación separado (LongMemEval local, M20d) antes de pasar a `apply`.
- Por eso el modo por defecto es **dry-run** (`NOVA_CONSOLIDATION_MODE=dry-run`): solo registra conteos en
  `ops_maintenance_runs` (`job='memory-consolidation'`). `apply` es reversible con el `run_id`.
- No detecta contradicciones si el sujeto no comparte prefijo (p. ej. orden de palabras distinto); se queda en `keep`.
