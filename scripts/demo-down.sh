#!/usr/bin/env bash
# Para lo que arrancó scripts/demo-up.sh (procesos + contenedores).
# Los datos de la BD se conservan en el volumen; para borrarlos:
#   docker compose -f infra/docker-compose.dev.yml down -v
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.demo"
for name in page web worker api; do
  if [ -f "$STATE/$name.pid" ]; then
    pid="$(cat "$STATE/$name.pid")"
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f "$STATE/$name.pid"
    echo "[demo] $name parado."
  fi
done
cd "$ROOT" && pnpm db:down
