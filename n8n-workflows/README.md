# n8n workflows

`demo-review-to-telegram-approve.json` — exported from the live phone n8n instance
(workflow id `ELk9R3m7jeGK5VAF`) on 2026-08-25. Review → Qwen draft → Telegram
approve/reject → paste-ready reply.

**Before re-importing this workflow anywhere:** every occurrence of
`TELEGRAM_BOT_TOKEN_PLACEHOLDER` needs to be replaced with the real bot token
from `.env` (`TELEGRAM_BOT_TOKEN`). The original export had the token baked
directly into HTTP Request node URLs (n8n's Telegram node was unusable — see
the gotchas in the root README) — it was scrubbed before this file was
committed, so the placeholder must be swapped back in on import, not left in
place.
