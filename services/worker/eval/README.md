# M20 — 50 casos sintéticos

`m20-synthetic-cases.json`: 50 casos inventados (sin datos reales), 10 por categoría:
`duplicate_exact`, `duplicate_near`, `contradiction`, `distinct`, `privacy_or_noise`.

- **M20a** (este PR): `src/memory/fact-extractor.test.ts` comprueba que el extractor heurístico produce
  exactamente `expected_facts` por momento (CI, sin red ni LLM).
- **M20c**: `expected_relation` (`merge` | `newer_wins` | `keep_both` | `no_fact` | `local_only_fact`) es la verdad
  conocida para medir precisión/recall de la consolidación.
