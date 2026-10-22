# M20d — Validación local con LongMemEval

Dataset: LongMemEval-S *cleaned* (licencia MIT, HF `xiaowu0162/longmemeval-cleaned`).
Se descarga en tiempo de ejecución a `.cache/longmemeval/` (gitignored); nunca se commitea ni se descarga en CI.
Sin juez LLM: todo se mide con `answer_session_ids` y `has_answer`.

```bash
pnpm eval:longmemeval --download   # primera vez (~277 MB)
pnpm eval:longmemeval --n 100      # subconjunto determinista (1 de cada 4)
```

Sin el archivo, el script imprime "omitido" y sale con 0. CI solo corre el test unitario con fixture (`src/eval/longmemeval-metrics.test.ts`).

## Resultados (22-oct-2026, 100 preguntas sin abstención, ~8 s en local)

### Búsqueda (a nivel de sesión, turnos de usuario, ~50 sesiones por pregunta)

| Ranker | R_any@1 | R_any@3 | R_any@5 | R_any@10 | R_all@5 | R_all@10 | MRR |
|---|---|---|---|---|---|---|---|
| BM25 (texto) | 81.0% | 92.0% | 96.0% | 97.0% | 79.0% | 86.0% | 0.876 |
| Trigramas (pg_trgm) | 23.0% | 44.0% | 55.0% | 75.0% | 32.0% | 51.0% | 0.388 |

BM25 por tipo (R_any@5 / MRR): single-session-user 100% / 0.969 · multi-session 96.7% / 0.861 ·
temporal-reasoning 96.9% / 0.895 · knowledge-update 100% / 0.964 · **preference 75% / 0.522** (más flojo).

Conclusión: la búsqueda por texto debe rankear con FTS tipo BM25 (`ts_rank`), no con `similarity()` de pg_trgm,
que sirve para encontrar candidatos de duplicado pero no para recuperar.

### Consolidación M20c fuera de muestra (dry-run, solo en memoria)

Positivos: pares de hechos extraídos (`extractFacts`) de turnos `has_answer` de sesiones de evidencia distintas (76 pares).
Negativos: hecho de evidencia vs. hechos de sesiones no relacionadas del mismo haystack (2760 pares).

| Umbrales (candidate / merge / conflict) | Positivos marcados | Falsos positivos |
|---|---|---|
| 0.30 / 0.50 / 0.45 (actuales) | 0/76 (0%) | 0/2760 (0%) |
| 0.30 / 0.60 / 0.45 | 0% | 0% |
| 0.30 / 0.50 / 0.55 | 0% | 0% |
| 0.40 / 0.60 / 0.55 | 0% | 0% |

Solo 5 de 76 pares positivos superan similitud 0.30 (mediana 0.15): en conversación real el mismo hecho se reformula
("watched all 22 MCU movies in two weeks" vs. "finished a Star Wars marathon…"), y las reglas léxicas
(anclas y prefijo compartido, pensados sobre los 50 casos sintéticos en español) no lo detectan.

**Lectura:** los umbrales son *seguros* (0 falsos merges/conflictos), así que no hay que subirlos; bajarlos tampoco
ayuda, porque el límite es léxico. La consolidación no aporta en datos reales todavía → **sigue en dry-run**.
El paso que la mejora son los embeddings locales (fase siguiente), usados para generar candidatos.

## Límites
- Subconjunto pequeño (100/470); el proxy de positivos mezcla "mismo hecho" con "evidencia relacionada".
- El extractor M20a es heurístico y genera hechos ruidosos sobre chat en inglés.
