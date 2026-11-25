## M20e · Embeddings locales para candidatos de consolidación (22-oct-2026)

- Modelo: `Xenova/all-MiniLM-L6-v2` (Apache-2.0, 384 dims, ONNX int8 vía `@huggingface/transformers`, dependencia opcional). Corre en la máquina; 0 gasto. Se descarga una vez a `.cache/models/` (gitignored) solo con `NOVA_MEMORY_EMBEDDINGS=local` (por defecto `off`); con `CI` definido se niega a cargarlo y los tests usan un embedder falso.
- Tabla aparte `memory_item_embeddings (memory_item_id, model, vector(384))` + índice HNSW coseno (migración 0017), porque la tabla `embeddings` es de 1536 dims.
- Candidatos = trigramas (0015) ∪ pares con coseno ≥ `THRESHOLDS.embedding` (0,55) en el mismo namespace. El coseno solo añade candidatos; un par solo semántico se informa como `conflict` (`embedding_neighbor`): gana el más nuevo o queda `contested` si hay un hecho del usuario. Nunca un merge silencioso. **La consolidación sigue en dry-run.**

Recalibración fuera de muestra (`pnpm eval:longmemeval -- --embeddings`, 76 pares positivos / 2760 negativos de LongMemEval-S):

| candidatos | recall | precisión | tp | fp |
|---|---|---|---|---|
| solo trigramas (M20c) | 0,0 % | — | 0/76 | 0/2760 |
| + embeddings ≥ 0,45 | 23,7 % | 78,3 % | 18 | 5 |
| + embeddings ≥ 0,50 | 18,4 % | 82,4 % | 14 | 3 |
| **+ embeddings ≥ 0,55 (elegido)** | **14,5 %** | **100 %** | 11 | 0 |
| + embeddings ≥ 0,60 | 7,9 % | 100 % | 6 | 0 |

Probados y descartados: `multilingual-e5-small` (cosenos comprimidos: negativos hasta 0,93, sin umbral útil) y `paraphrase-multilingual-MiniLM-L12-v2` (con 0,55: 7 tp / 4 fp). Limitación: all-MiniLM-L6-v2 es solo inglés; para memoria en español hay que validar un modelo multilingüe con casos en español antes de aplicar.

## M20i · Vectores obsoletos tras editar un hecho (25-nov-2026)

- Problema: la consolidación solo calculaba vectores que **faltaban**. Un `PATCH .../memory/:id` que cambia `content` dejaba el vector del texto viejo, y los candidatos semánticos se decidían con el significado anterior.
- Migración 0019: `memory_item_embeddings.content_sha256` (nullable) = sha256 del texto **exacto** que se pasó al modelo. No reutiliza `memory_items.content_hash` (sha256 del texto normalizado): un cambio de mayúsculas o espacios es otra entrada para el modelo, y hay filas antiguas sin `content_hash`.
- Cada corrida compara el hash guardado con el del contenido actual y recalcula solo los distintos (upsert). Filas previas a 0019 (hash NULL) se recalculan una vez. El informe añade `embeddings_refreshed`. Sigue en dry-run respecto a `memory_items`.
- Rollback LIFO: `rollback/0019_…down.sql` antes que `rollback/0017_…down.sql`; el de 0017 se niega si 0019 sigue registrada.
- Límite conocido: el refresco es perezoso (en la siguiente corrida de consolidación), no en el `PATCH`. Entre la edición y la corrida el vector viejo existe pero nada lo lee fuera de la consolidación.
