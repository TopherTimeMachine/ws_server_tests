#!/usr/bin/env bash
# Launch all six WebSocket servers and the Svelte client. Ctrl+C stops everything.
# Usage: sh/start-all.sh [--no-client]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/sh/logs"
mkdir -p "$LOGS"
PIDS=()

killtree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do killtree "$child"; done
  kill "$1" 2>/dev/null
}

cleanup() {
  echo; echo "Stopping..."
  for pid in "${PIDS[@]}"; do killtree "$pid"; done
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM EXIT

# start <name> <dir> <command...>
start() {
  local name=$1 dir=$2; shift 2
  echo "starting $name ..."
  (cd "$ROOT/$dir" && exec "$@" >"$LOGS/$name.log" 2>&1) &
  PIDS+=($!)
}

# --- Node ---
[ -d "$ROOT/node-server/node_modules" ] || (cd "$ROOT/node-server" && npm install --silent)
start node node-server node server.js

# --- Rust (release build) ---
(cd "$ROOT/rust-server" && cargo build --release --quiet) || echo "rust build failed"
start rust rust-server ./target/release/speed-test-rust-server

# --- Elixir (prod) ---
if command -v mix >/dev/null; then
  (cd "$ROOT/elixir-server" && MIX_ENV=prod mix deps.get >/dev/null && MIX_ENV=prod mix compile >/dev/null) || echo "elixir build failed"
  start elixir elixir-server env MIX_ENV=prod mix run --no-halt
else
  echo "elixir not installed: skipping elixir server"
fi

# --- Bun ---
if command -v bun >/dev/null; then
  start bun bun-server bun run server.ts
else
  echo "bun not installed: skipping bun server"
fi

# --- Go ---
if command -v go >/dev/null; then
  (cd "$ROOT/go-server" && go mod tidy >/dev/null 2>&1 && go build -o speed_server .) || echo "go build failed"
  start go go-server ./speed_server
else
  echo "go not installed: skipping go server"
fi

# --- C++ (release build) ---
if command -v cmake >/dev/null; then
  (cd "$ROOT/cpp-server" && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build build -j >/dev/null) || echo "c++ build failed"
  start cpp cpp-server ./build/speed_server
else
  echo "cmake not installed: skipping c++ server"
fi

# --- Client ---
if [ "${1:-}" != "--no-client" ]; then
  [ -d "$ROOT/client/node_modules" ] || (cd "$ROOT/client" && npm install --silent)
  start client client npm run dev
fi

sleep 2
cat <<MSG

  Node    ws://localhost:8081/ws
  Rust    ws://localhost:8082/ws
  Elixir  ws://localhost:8083/ws
  Bun     ws://localhost:8084/ws
  Go      ws://localhost:8085/ws
  C++     ws://localhost:8086/ws
  Client  http://localhost:5173

  Logs: $LOGS/*.log   (Ctrl+C to stop all)
MSG
wait
