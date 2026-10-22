# M20a — Riesgo de prompt injection en hechos de memoria

Revisión de Claude Code en el PR #25, puntos 3 y 4.

## Riesgo
Con `redaction_state = 'skipped'` (redacción desactivada), el extractor lee el texto capturado
sin filtrar, que puede venir de una página web o un chat. Una frase como
"Ignore all previous instructions…" podría guardarse como hecho y, cuando M20c (consolidación)
u otro consumidor pase hechos a un LLM, actuar como inyección persistente.

## Mitigación (M20a)
1. **Marcado:** `isInstructionLike()` detecta contenido con forma de instrucción (ES/EN: "ignora las
   instrucciones", "system prompt", "you are now", `system:`, `<system>`, `[INST]`, `<|…|>`).
   Esos hechos se guardan igual (son datos), con `metadata.instruction_like = true`.
2. **Neutralización:** `neutralizeFact()` elimina caracteres de control e invisibles (bidi, zero-width)
   y desactiva secuencias que rompen sobres (```` ``` ````, `<|`, `<system>`, `</untrusted_memory_facts>`).
3. **Procedencia:** cada hecho guarda `metadata.trust = "untrusted"`, `redaction_state` y `source_mode`.
4. **Hechos como datos en M20c:** todo consumidor que pase hechos a un LLM DEBE usar
   `renderFactsAsData()`: JSON dentro de `<untrusted_memory_facts>` con la advertencia de no seguir
   instrucciones. Nunca interpolar `content` como prosa en un prompt. Los hechos con
   `instruction_like = true` no deben resolver conflictos automáticamente.

## Pendiente
- El filtro de PII para `skipped` (emails, teléfonos, tarjetas) no está en este cambio; necesita decisión
  (reutilizar el pipeline de redacción o tratar `skipped` como "sin datos sensibles").
- La heurística es una defensa en profundidad, no una garantía.
