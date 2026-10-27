#!/data/data/com.termux/files/usr/bin/bash
# DuckDNS updater â keeps YOUR-SUBDOMAIN.duckdns.org pointing at this phone's LAN IP
# Also runs acme.sh renewal check on every tick (no system cron on this phone)
set -a
source "$HOME/server/.env"
set +a
DOMAIN="${DUCKDNS_DOMAIN}"
TOKEN="${DUCKDNS_TOKEN}"
LAST_FILE="$HOME/server/.duckdns-last-ip"

log() { echo "[$(date '+%F %T')] $*"; }

while true; do
    ip=$(node ~/server/ip-detect.js 2>/dev/null)
    if [ -n "$ip" ]; then
        out=$(curl -sS --max-time 20 "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=${ip}")
        log "duckdns update: ip=${ip} reply=${out}"
        echo "$ip" > "$LAST_FILE"
    fi

    # cert renewal check (acme.sh renews when <30 days left; ~no-op otherwise)
    ~/.acme.sh/acme.sh --cron --home ~/.acme.sh >/dev/null 2>&1

    sleep 300
done
