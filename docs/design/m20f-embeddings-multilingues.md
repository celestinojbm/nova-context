# M20f — Validación de embeddings multilingües (español)

Dry-run, local, sin coste. `pnpm --filter @nova/worker eval:multilingual --download` descarga los modelos a `.cache/models/` (ignorado por git). Omitido en CI. Nada cambia en producción: `NOVA_MEMORY_EMBEDDINGS` sigue en `off` y el modelo por defecto sigue siendo all-MiniLM-L6-v2.

Dataset: `services/worker/eval/m20-multilingual-es-cases.json`, con 60 pares sintéticos en español. Hay 30 positivos (15 paráfrasis y 15 actualizaciones del mismo hecho) y 30 negativos (tema distinto con palabras en común).

| Modelo | Umbral (mejor F1) | Precisión | Recall | F1 | Recall con 0 FP |
|---|---|---|---|---|---|
| all-MiniLM-L6-v2 (M20e) | 0.384 | 54.5% | 100% | 0.706 | 40.0% (t=0.745) |
| multilingual-e5-small, query:/query: | 0.900 | 96.7% | 96.7% | 0.967 | 80.0% (t=0.914) |
| multilingual-e5-small, query:/passage: | 0.888 | 92.9% | 86.7% | 0.897 | 63.3% (t=0.898) |
| paraphrase-multilingual-MiniLM-L12-v2 | 0.061 | 51.7% | 100% | 0.682 | 13.3% (t=0.694) |

Conclusión: el mejor es multilingual-e5-small con el prefijo simétrico `query:` en los dos textos, que es el uso recomendado por e5 para similitud. `query:/passage:` es asimétrico, pensado para búsqueda, y aquí rinde peor. Los umbrales están ajustados con estos mismos datos, así que hay que validarlos fuera de muestra (LongMemEval y más casos) antes de cambiar el modelo por defecto.
