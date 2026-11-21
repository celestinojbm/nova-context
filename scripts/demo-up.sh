#!/usr/bin/env bash
# M19 — arranque LOCAL de la demo (bucle básico, sin voz, Live Context ni Notion).
# Sin despliegue, sin servicios de pago, sin datos reales: todas las claves de
# proveedores en la nube se fuerzan VACÍAS y las funciones cloud a "off".
#
#   scripts/demo-up.sh          # levanta todo y siembra datos sintéticos
#   scripts/demo-down.sh        # lo para
#
# Flujo de la demo: docs/ROADMAP.md (sección M19) y docs/DEMO.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.demo"
LOGS="$STATE/logs"
API_PORT="${NOVA_DEMO_API_PORT:-3001}"
WEB_PORT=3000
PAGE_PORT="${NOVA_DEMO_PAGE_PORT:-8080}"
mkdir -p "$LOGS"
cd "$ROOT"

say() { printf '\n\033[1m[demo]\033[0m %s\n' "$*"; }
die() { printf '\n[demo] ERROR: %s\n' "$*" >&2; exit 1; }

# --- 0. Requisitos -------------------------------------------------------------
for bin in docker node pnpm curl openssl python3; do
  command -v "$bin" >/dev/null || die "falta '$bin' en el PATH."
done
docker info >/dev/null 2>&1 || die "Docker no responde (HANDOFF.md: a veces hay que arrancar dockerd a mano)."

# --- Entorno: SOLO local, nada de nube ------------------------------------------
if [ ! -f "$STATE/encryption.key" ]; then
  (umask 077; openssl rand -hex 32 > "$STATE/encryption.key")   # clave local de demo, nunca se sube
fi
export NODE_ENV=development
export DATABASE_URL="postgres://nova:nova@localhost:5432/nova"
export REDIS_URL="redis://localhost:6379"
export PORT="$API_PORT"
export NOVA_API_URL="http://localhost:$API_PORT"
export NOVA_ENCRYPTION_KEY="$(cat "$STATE/encryption.key")"
export NOVA_MEDIA_STORE=fs
export NOVA_MEDIA_FS_ROOT="$STATE/media"
export NOVA_SIGNUP=open
export NOVA_REDACTION=on NOVA_IMAGE_REDACTION=on NOVA_SCREENSHOT_STORAGE=on
# Sin coste ni nube: sin claves, sin Live Q&A, sin enriquecimiento LLM, sin Notion.
unset OPENAI_API_KEY ANTHROPIC_API_KEY NOTION_CLIENT_ID NOTION_CLIENT_SECRET
export NOVA_LIVE_QA=off NOVA_CLOUD_ENRICHMENT=off NOVA_ANALYTICS=local
mkdir -p "$NOVA_MEDIA_FS_ROOT"
# Un .env local con claves podría reactivar la nube: avisar y parar.
for f in services/api/.env services/worker/.env; do
  if [ -f "$f" ] && grep -Eq '^(OPENAI_API_KEY|ANTHROPIC_API_KEY|NOTION_CLIENT_ID)=.+' "$f"; then
    die "$f contiene claves de proveedores en la nube; vacíalas para la demo (sin coste)."
  fi
done

# --- Infra + esquema -----------------------------------------------------------
say "Instalando dependencias y levantando Postgres + Redis (Docker local)…"
pnpm install --frozen-lockfile >"$LOGS/install.log" 2>&1 || die "pnpm install falló (ver $LOGS/install.log)."
pnpm db:up >"$LOGS/db.log" 2>&1 || die "pnpm db:up falló (ver $LOGS/db.log)."
for i in $(seq 1 30); do
  docker compose -f infra/docker-compose.dev.yml exec -T postgres pg_isready -U nova -d nova >/dev/null 2>&1 && break
  [ "$i" = 30 ] && die "Postgres no arrancó."; sleep 2
done
pnpm db:migrate >"$LOGS/migrate.log" 2>&1 || die "db:migrate falló (ver $LOGS/migrate.log)."

# --- Servicios en segundo plano ------------------------------------------------
start() { # nombre, comando…
  local name="$1"; shift
  if [ -f "$STATE/$name.pid" ] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then
    say "$name ya está corriendo."; return
  fi
  setsid "$@" >"$LOGS/$name.log" 2>&1 &
  echo $! >"$STATE/$name.pid"
}
say "Arrancando API (:$API_PORT), worker, web (:$WEB_PORT) y página de demo (:$PAGE_PORT)…"
start api    pnpm --filter @nova/api dev
start worker pnpm --filter @nova/worker dev
start web    pnpm --filter @nova/web dev
start page   python3 -m http.server "$PAGE_PORT" --bind 127.0.0.1 --directory "$ROOT/demo/page"

for i in $(seq 1 60); do
  curl -fs "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && die "La API no quedó lista (ver $LOGS/api.log)."; sleep 2
done

# --- Datos sintéticos + extensión ------------------------------------------------
say "Sembrando la cuenta sintética…"
NOVA_DEMO_API="http://localhost:$API_PORT" node demo/seed.mjs
say "Compilando la extensión…"
pnpm --filter @nova/extension build >"$LOGS/extension.log" 2>&1 || die "build de la extensión falló (ver $LOGS/extension.log)."

cat <<MSG

==================== DEMO M19 LISTA (local) ====================
Cuenta:   demo@nova.local / nova-demo-password   (sintética)
Web:      http://localhost:$WEB_PORT
Página:   http://localhost:$PAGE_PORT   (datos sensibles FALSOS)
Extensión: chrome://extensions → Cargar descomprimida →
           $ROOT/apps/extension/.output/chrome-mv3
           Emparejar: web → Ajustes → Browser extension → Generate pairing code

Guion (docs/ROADMAP.md, 3–5 min):
 1. Problema: una captura pierde significado, intención y proyecto.
 2. En la página de demo: abrir el panel de la extensión, capturar y ESCRIBIR
    la instrucción (sin voz): "Añade como tarea del proyecto Atlas: revisar el
    presupuesto de marketing antes del jueves".
 3. Web → línea de tiempo: abrir el momento; zonas sensibles tapadas y estado
    de redacción.
 4. Buscar "presupuesto" → aparece; buscar "4242" o "ana.demo" → NO aparece.
 5. Aprobaciones → aprobar la acción → verla en Tareas.
 6. Auditoría y Ajustes → exportar/borrar.
Logs: $LOGS     Parar: scripts/demo-down.sh
=================================================================
MSG
