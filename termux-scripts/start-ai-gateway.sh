#!/data/data/com.termux/files/usr/bin/bash
# ai-gateway :8082 inside proot Ubuntu — pm2 app "ai-gateway"
# MUST run inside proot (glibc Node 22 + better-sqlite3/vec0). It spawns the Termux
# llama-server binaries itself as children of THIS long-lived proot session — never
# spawn llama from a short-lived proot login (children freeze when the tracer exits).
#
# `env -i` is required (a leaked Termux PATH picks up Node 24 and breaks the native
# modules), but it also wipes every tunable, so each one is forwarded explicitly.
# Without this the env knobs silently do nothing — server.js just sees its defaults.
# Empty values are safe: every read is `process.env.X || <default>`.
exec /data/data/com.termux/files/usr/bin/proot-distro login ubuntu -- env -i \
  PATH=/usr/local/node/bin:/usr/bin:/bin \
  HOME=/root \
  PORT="${PORT:-}" \
  MIN_FREE_MB="${MIN_FREE_MB:-}" \
  IDLE_KILL_MS="${IDLE_KILL_MS:-}" \
  IDLE_KILL_MS_CHAT="${IDLE_KILL_MS_CHAT:-}" \
  IDLE_KILL_MS_EMBED="${IDLE_KILL_MS_EMBED:-}" \
  E5_ASYMMETRIC="${E5_ASYMMETRIC:-}" \
  RAG_DB="${RAG_DB:-}" \
  VEC0="${VEC0:-}" \
  /usr/local/node/bin/node /data/data/com.termux/files/home/server/ai-gateway/server.js
