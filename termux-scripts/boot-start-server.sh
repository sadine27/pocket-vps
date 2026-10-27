#!/data/data/com.termux/files/usr/bin/bash
# start-server.sh v3 — run by Termux:Boot at device boot. Idempotent.
# v3: pm2 step runs DETACHED + DELAYED (nohup, +25s). The boot receiver tears down
# its process group when it finishes — a synchronous resurrect gets killed with it.
export PATH=/data/data/com.termux/files/usr/bin:$PATH
LOG=~/server/boot.log
mkdir -p ~/server
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "=== boot script start (pid $$) ==="

# 1) Wake lock (needs Termux:API)
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock && log "wake lock acquired" || log "wake lock FAILED"
fi

# 2) sshd
if pgrep -x sshd >/dev/null 2>&1; then
  log "sshd already running"
else
  sshd && log "sshd started" || log "sshd FAILED"
fi

# 3) Services via pm2 — detached + delayed so receiver teardown can't kill them
nohup bash -c '
  sleep 25
  export PATH=/data/data/com.termux/files/usr/bin:$PATH
  LOG=/data/data/com.termux/files/home/server/boot.log
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] delayed pm2 step: resurrecting" >> "$LOG"
  pm2 resurrect >/dev/null 2>&1
  sleep 10
  if pm2 jlist 2>/dev/null | grep -q "\"name\""; then
    echo "[$(date "+%Y-%m-%d %H:%M:%S")] pm2 apps running: $(pm2 jlist 2>/dev/null | grep -o "\"name\":\"[^\"]*\"" | tr "\n" " ")" >> "$LOG"
  else
    pm2 start /data/data/com.termux/files/home/server/ecosystem.config.js >/dev/null 2>&1 && \
      echo "[$(date "+%Y-%m-%d %H:%M:%S")] started from ecosystem.config.js" >> "$LOG"
    pm2 save >/dev/null 2>&1
  fi
' >/dev/null 2>&1 &

log "pm2 resurrection scheduled (detached, +25s)"
log "=== boot script done ==="
