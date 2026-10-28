# M20g: multilingual-e5-small (query:/query:) fuera de muestra con LongMemEval

Es un dry-run local y sin gasto, sin juez LLM. CI no descarga modelos: el script `localEmbedder` falla a propósito si detecta `CI`. Producción no cambia: `NOVA_MEMORY_EMBEDDINGS=off` y el modelo por defecto sigue siendo all-MiniLM-L6-v2.

Para reproducirlo: `pnpm --filter @nova/worker eval:longmemeval --download --embeddings [--model Xenova/multilingual-e5-small]`

Datos: LongMemEval-S, 100 preguntas, 76 pares positivos y 2760 negativos, los mismos que en M20e. Solo se mide el coseno.

| Modelo | Umbral | Precisión | Recall | F1 |
|---|---|---|---|---|
| all-MiniLM-L6-v2 | 0.55 (M20e) | 100% | 13.2% | 0.233 |
| all-MiniLM-L6-v2 | 0.349 (mejor F1 en LME) | 51.5% | 46.1% | **0.486** |
| e5-small q/q | 0.900 (mejor F1 del set ES) | 75.0% | 3.9% | 0.075 |
| e5-small q/q | 0.914 (0 FP en el set ES) | 100% | 1.3% | 0.026 |
| e5-small q/q | 0.868 (mejor F1 en LME) | 27.0% | 22.4% | 0.245 |

**Los umbrales no aguantan.** El 0.90 calibrado en español baja de F1 0.967 a 0.075 fuera de muestra. El coseno de e5 está muy concentrado (0.85–0.93) y separa mal en LongMemEval, que está en inglés. Incluso con su mejor umbral en LME, e5 (0.245) queda por debajo de MiniLM-L6 (0.486).

Recomendación: no cambiar el modelo por defecto. Si la memoria va a estar sobre todo en español, hace falta un set ES fuera de muestra más grande, con hechos reales extraídos, antes de decidir. Una opción es usar un modelo por idioma.
