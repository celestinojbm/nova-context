
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
