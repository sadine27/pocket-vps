#!/data/data/com.termux/files/usr/bin/bash
# Caddy reverse proxy (Termux pkg caddy)
export PATH=/data/data/com.termux/files/usr/bin:$PATH
exec caddy run --config /data/data/com.termux/files/home/server/Caddyfile
