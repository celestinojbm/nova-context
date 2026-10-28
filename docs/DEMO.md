# Demo M19 — arranque local

Demo **local** del bucle básico de Nova (captura con la extensión → momento redactado → búsqueda → acción aprobada → auditoría/exportar). Fuera de alcance: voz, Live Context Mode y Notion. Sin despliegue, sin servicios de pago, sin datos reales.

## Qué incluye

| Archivo | Qué es |
|---|---|
| `scripts/demo-up.sh` | Levanta Postgres + Redis (Docker local), migra, arranca API, worker, web y la página de demo, siembra la cuenta sintética y compila la extensión. Fuerza las claves cloud vacías y `NOVA_LIVE_QA=off`, `NOVA_CLOUD_ENRICHMENT=off`; se para si un `.env` local trae claves. |
| `scripts/demo-down.sh` | Para los procesos y los contenedores (conserva la BD). |
| `demo/page/index.html` | Página "Proyecto Atlas" con datos sensibles **falsos** (email `@example.com`, tarjeta de prueba `4242…`, teléfono `555`), en texto grande para que el OCR los detecte. Servida en `http://localhost:8080`. |
| `demo/seed.mjs` | Crea `demo@nova.local` y 3 momentos de texto sintéticos. Se niega a escribir en una API que no sea `localhost`. Idempotente. |

## Uso

```bash
scripts/demo-up.sh
# … demo …
scripts/demo-down.sh
```

Requisitos: Docker, Node ≥ 22, pnpm, python3, openssl, Chrome/Chromium.

## Guion (6 pasos, ver `docs/ROADMAP.md`)

1. Problema en una frase.
2. En `http://localhost:8080`, abrir el panel de la extensión, capturar y **escribir** la instrucción: *"Añade como tarea del proyecto Atlas: revisar el presupuesto de marketing antes del jueves"*.
3. Web → línea de tiempo → abrir el momento: zonas sensibles tapadas y estado de redacción.
4. Buscar `presupuesto` → aparece; buscar `4242` o `ana.demo` → **no** aparece.
5. Aprobaciones → aprobar → ver la tarea.
6. Auditoría y Ajustes → exportar/borrar.

## Por verificar

- Ensayo completo en una máquina limpia (el script no se ha ejecutado de punta a punta con Docker en CI).
- Sin `NOVA_OCR_LANG_PATH`, Tesseract descarga los datos de idioma una vez desde su CDN público (gratis); para una demo sin red, vendorizarlos.
- Que la búsqueda sin claves (solo palabras clave) y el enriquecimiento heurístico local den una sugerencia de proyecto/acción convincente para "Atlas".
