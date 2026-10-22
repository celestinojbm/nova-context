
## M20 · Búsqueda por texto con ranking tipo BM25 en Postgres (22-oct-2026)

`GET /v1/namespaces/<slug>/memory?q=` deja de ser `ILIKE` ordenado por fecha:

- Migración `0016_m20_memory_fts.sql`: columna generada `memory_items.tsv = to_tsvector('simple', content)` + índice GIN. `'simple'` porque la memoria mezcla español e inglés.
- Consulta OR sobre los tokens de `q` sin stopwords (EN + ES), ordenada por `ts_rank(tsv, q, 1)` (normalización por log de longitud).
- Trigramas solo como respaldo: `q <% content` (word_similarity, índice GIN trgm de 0015) e `ILIKE` para erratas y subcadenas; desempate por `word_similarity` y luego fecha.

Validación local (`pnpm eval:longmemeval -- --pg`, LongMemEval-S, 100 preguntas, nivel de sesión, mismo SQL sobre tabla TEMP):

| ranking | R_any@1 | R_any@5 | R_all@5 | R_any@10 | MRR |
|---|---|---|---|---|---|
| trigramas (antes) | 23,0 % | 55,0 % | 32,0 % | 75,0 % | 0,388 |
| **Postgres `ts_rank` (ahora)** | 80,0 % | 93,0 % | 74,0 % | 96,0 % | 0,857 |
| BM25 Okapi en memoria (referencia) | 81,0 % | 96,0 % | 79,0 % | 97,0 % | 0,876 |

Barrido de configuraciones: `ts_rank_cd` rinde peor (MRR 0,77–0,83) y, sin quitar stopwords del query, `'simple'` cae a MRR 0,35. `ts_rank` no tiene IDF; la brecha de ~3 pts en R@5 frente a BM25 real es el coste de quedarse en Postgres sin extensiones.
