#!/data/data/com.termux/files/usr/bin/bash
# llama-server (Qwen3.5-4B) — pm2 app "llama" (Termux native, NOT proot)
# --reasoning off is REQUIRED: Qwen3.5 thinks by default and burns the whole
# token budget on a "Thinking Process" without replying.
# Log: ~/.pm2/logs/llama-out.log / llama-error.log
#
# Tuning notes (2026-08-18), after a real draft was cancelled at 300s while still
# READING its prompt at 86%:
#   --mlock   The 2.6GB model is mmap'd from flash. The phone runs with ~56MB free and
#             ~4GB of page cache under constant pressure, so model pages were being
#             evicted and re-read from storage during inference — prompt processing
#             measured 2.2 tok/s, roughly 5x below what this SoC should manage.
#             mlock pins the weights in RAM. `ulimit -l` is unlimited here, so the lock
#             is permitted. If Android's low-memory killer ever starts reaping the
#             process, drop this flag first.
#   -b/-ub    128 meant prompt tokens were processed 128 at a time, which wastes the
#             wider matrix multiply. 512 matches the same fix already applied to the
#             embedding server, where an undersized batch was the blocker.
#   -t 4      MT6769 (Helio G85) is 2x Cortex-A75 + 6x A55. Four threads beat two here;
#             going wider drags the fast cores down to A55 pace.
exec /data/data/com.termux/files/usr/bin/llama-server \
  -m /data/data/com.termux/files/home/server/llama/models/Qwen3.5-4B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8081 \
  -c 2048 \
  -t 4 \
  -b 512 \
  -ub 512 \
  --mlock \
  --no-webui \
  -np 1 \
  --alias qwen3.5-4b \
  --reasoning off
