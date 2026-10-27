#!/usr/bin/env bash
# n8n-api.sh - read-only helper for the self-hosted n8n Public API (phone server)
#
# Usage:
#   ./n8n-api.sh list-workflows              # id / name / active state
#   ./n8n-api.sh get-workflow <id>           # full workflow JSON
#   ./n8n-api.sh list-executions [limit]     # recent executions (default 20)
#   ./n8n-api.sh get-execution <id>          # full execution JSON
#   ./n8n-api.sh ping                        # is the server reachable? (no key needed)
#
# API key: one line in ~/review-bot/n8n-api-key.txt  OR  export N8N_API_KEY=...
# (Create the key in n8n: Settings -> n8n API -> Create API key.)

set -euo pipefail

# Candidate API base URLs (pick whichever the rebuilt server answers;
# override with env N8N_API_URL):
#   https://YOUR-SUBDOMAIN.duckdns.org:8443/n8n   <- default; n8n runs with N8N_PATH=/n8n/
#   https://YOUR-SUBDOMAIN.duckdns.org:8443       <- try if the /n8n prefix 404s
#   http://192.168.1.189:8080/n8n              <- LAN (HTTP) alternative
# Verify with: ./n8n-api.sh ping
# Quick probe: curl -o /dev/null -w '%{http_code}' <base>/api/v1/workflows
#   401 = prefix correct (route exists, needs key) | 404 = wrong prefix
BASE_URL="${N8N_API_URL:-https://YOUR-SUBDOMAIN.duckdns.org:8443/n8n}"
KEY_FILE="$HOME/review-bot/n8n-api-key.txt"

die() { echo "error: $*" >&2; exit 1; }

get_key() {
  # The laptop's shell profile exports N8N_API_KEY for the n8n CLOUD instance
  # (YOUR-INSTANCE.app.n8n.cloud, Codex MCP) — never valid against the phone.
  # When the base URL points at the phone, the key file wins over ambient env.
  if [[ -z "${N8N_API_KEY:-}" || "$BASE_URL" == *"divyesh-n8n"* || "$BASE_URL" == *"192.168."* ]]; then
    if [[ -f "$KEY_FILE" ]]; then
      local key
      key="$(tr -d '\r\n ' < "$KEY_FILE")"
      if [[ -n "$key" ]]; then
        printf '%s' "$key"
        return
      fi
      echo "warning: $KEY_FILE exists but is empty" >&2
    fi
  fi
  if [[ -n "${N8N_API_KEY:-}" ]]; then
    printf '%s' "$N8N_API_KEY"
    return
  fi
  echo "No n8n API key found." >&2
  echo "One-time setup:" >&2
  echo "  1. Open https://YOUR-SUBDOMAIN.duckdns.org:8443/n8n/ and sign in" >&2
  echo "  2. Settings -> n8n API -> Create API key (read-only scope is fine)" >&2
  echo "  3. Paste the key as a single line into:" >&2
  echo "       $KEY_FILE" >&2
  echo "  (or export N8N_API_KEY=... instead of a file)" >&2
  exit 1
}

# pretty-print raw JSON through node (present on this laptop); fall back to raw
pretty() {
  if command -v node >/dev/null 2>&1; then
    node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.stringify(JSON.parse(d),null,2))}catch(e){console.log(d)}})'
  else
    cat
  fi
}

case "${1:-}" in
  ping)
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 "$BASE_URL/healthz" || true)"
    case "$code" in
      200|404) echo "server up ($code) - base URL: $BASE_URL" ;;
      000) echo "server unreachable - is the phone's Termux/pm2 running?" >&2; exit 1 ;;
      *) echo "server responded ($code)" ;;
    esac
    ;;
  list-workflows)
    API_KEY="$(get_key)"
    curl -sS -H "X-N8N-API-KEY: $API_KEY" "$BASE_URL/api/v1/workflows" | node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
        let j; try { j=JSON.parse(d); } catch(e){ console.log(d); process.exit(0); }
        if (j.code || !Array.isArray(j.data)) { console.log(JSON.stringify(j,null,2)); process.exit(0); }
        console.log("id\tstate\tname");
        for (const w of j.data) console.log(w.id+"\t"+(w.active?"active":"paused")+"\t"+w.name);
      })'
    ;;
  get-workflow)
    [[ $# -ge 2 ]] || die "usage: $0 get-workflow <id>"
    API_KEY="$(get_key)"
    curl -sS -H "X-N8N-API-KEY: $API_KEY" "$BASE_URL/api/v1/workflows/$2" | pretty
    ;;
  list-executions)
    lim="${2:-20}"
    API_KEY="$(get_key)"
    curl -sS -H "X-N8N-API-KEY: $API_KEY" "$BASE_URL/api/v1/executions?limit=$lim" | node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
        let j; try { j=JSON.parse(d); } catch(e){ console.log(d); process.exit(0); }
        if (j.code || !Array.isArray(j.data)) { console.log(JSON.stringify(j,null,2)); process.exit(0); }
        console.log("id\tworkflowId\tstatus\tstartedAt");
        for (const e of j.data) console.log(e.id+"\t"+e.workflowId+"\t"+(e.status||e.finished)+"\t"+(e.startedAt||""));
      })'
    ;;
  get-execution)
    [[ $# -ge 2 ]] || die "usage: $0 get-execution <id>"
    API_KEY="$(get_key)"
    curl -sS -H "X-N8N-API-KEY: $API_KEY" "$BASE_URL/api/v1/executions/$2" | pretty
    ;;
  *)
    die "usage: $0 {list-workflows|get-workflow <id>|list-executions [limit]|get-execution <id>|ping}"
    ;;
esac
