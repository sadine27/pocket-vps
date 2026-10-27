#!/data/data/com.termux/files/usr/bin/bash
# n8n v2.8.4 inside proot Ubuntu — pm2 app "n8n"
# Absolute proot-distro path + env -i: keeps Termux Node 24 & its env OUT of the container,
# so /usr/local/node (Node 22, glibc) is the only node n8n sees and sqlite3 loads cleanly.
# NODE_OPTIONS ipv4first: office WiFi has broken IPv6 (RA works, packets blackhole) and
# n8n's HTTP client has no Happy-Eyeballs fallback — v6 connects hang until timeout.
exec /data/data/com.termux/files/usr/bin/proot-distro login ubuntu -- env -i \
  PATH=/usr/local/node/bin:/usr/bin:/bin \
  HOME=/root \
  NODE_OPTIONS=--dns-result-order=ipv4first \
  N8N_PORT=5678 \
  N8N_HOST=0.0.0.0 \
  N8N_PROTOCOL=http \
  N8N_PATH=/n8n/ \
  N8N_USER_FOLDER=/data/data/com.termux/files/home/server/n8n-data \
  WEBHOOK_URL=https://YOUR-SUBDOMAIN.duckdns.org:8443/n8n \
  N8N_RUNNERS_ENABLED=false \
  N8N_SECURE_COOKIE=false \
  /usr/local/node/bin/n8n start
