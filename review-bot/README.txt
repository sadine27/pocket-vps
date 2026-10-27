n8n workspace reader (Claude Code -> n8n on the phone server)
=============================================================

ONE-TIME USER ACTION (the only thing you need to do):
------------------------------------------------------
1. Open https://YOUR-SUBDOMAIN.duckdns.org:8443/n8n/  and sign in
2. Go to Settings -> n8n API -> Create API key
   (choose "Read-only" scope if offered - this is for reading only)
3. Copy the key and paste it as a single line into:
       C:\Users\divye\review-bot\n8n-api-key.txt
   (create the file if it does not exist; save, done)

After that, Claude Code can run ./n8n-api.sh to inspect your
workflows and executions. No key needed for the fallback paths
(SSH/sqlite), which are also read-only.

Usage (in Git Bash):
    bash n8n-api.sh list-workflows            # id / name / active
    bash n8n-api.sh get-workflow <id>         # full JSON of one workflow
    bash n8n-api.sh list-executions [limit]   # recent runs (default 20)
    bash n8n-api.sh get-execution <id>        # full JSON of one execution
    bash n8n-api.sh ping                      # is the server reachable?

Alternative to the key file: export N8N_API_KEY=... in the shell.

Notes
-----
- Base URL used: https://YOUR-SUBDOMAIN.duckdns.org:8443/n8n  (n8n's N8N_PATH=/n8n/)
  Override with env N8N_API_URL if it ever changes.
- NOT YET VERIFIED: the phone server was down when this was written
  (2026-08-13, Termux wiped from the phone). After the server is rebuilt,
  run "bash n8n-api.sh ping" once - if it says 404, drop the /n8n prefix via
  N8N_API_URL=https://YOUR-SUBDOMAIN.duckdns.org:8443
  (401 on /api/v1/workflows = prefix right, 404 = wrong prefix).
- If the server is unreachable (ping fails), the phone's Termux/pm2
  is likely stopped; restart it on the phone (pm2 resurrect).
- DB fallback (no API key): resolve the phone first, then ssh to it.
  The IP is DHCP and it moves - it was 192.168.1.189, today it is 192.168.1.xxx.
  Do NOT scan the subnet to find it; DuckDNS already publishes the LAN address:
      PHONE=$(nslookup YOUR-SUBDOMAIN.duckdns.org | awk '/^Address/{ip=$2} END{print ip}')
      ssh -i ~/.ssh/phone_server -p 8022 "$PHONE"
  then inspect ~/server/n8n-data/database.sqlite with sqlite3 (read-only).
