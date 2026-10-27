# Pocket VPS: self-hosted AI server on a phone

AI server for T3 Thakali & Multi Food Gallery: Google review scraping, a
RAG-backed reply drafter (Qwen3.5-4B + e5-small embeddings, running locally),
and a Telegram approve/reject workflow in n8n. Runs on a Redmi 13 phone
(Termux) acting as a pocket VPS, reachable via DuckDNS + Let's Encrypt.

## Layout

- `review-bot/` — scraping, corpus-building, and n8n-debugging helper scripts.
  `rag-ingest/` holds the processed review/reply corpus (110–120 pairs) used
  to seed retrieval.
- `ai-gateway/` — the RAG + LLM service (`server.js`) that runs on the phone
  inside a proot Ubuntu container: chat proxy, embedding ingest, sqlite-vec
  search, idle-kill memory management for the spawned llama-server.
- `termux-scripts/` — everything that keeps the phone stack alive: Caddy
  reverse proxy config, pm2 `ecosystem.config.js`, per-service `start-*.sh`
  wrappers, the DuckDNS updater, and the Termux:Boot auto-start script.
- `n8n-workflows/` — exported workflow JSON (secrets scrubbed to
  placeholders — see that folder's README before re-importing).
- `scrape-reviews.js` / `scrape-reviews-v2.js` — Google Maps review scrapers
  (run in DevTools console on the listing's own Maps page).

## Setup on a new device

1. Copy `.env.example` to `.env` and fill in real values (SSH, Telegram,
   DuckDNS, n8n, GCP — see that file for what's needed).
2. Termux side: install `nodejs`, `proot-distro`, `caddy`, `pm2` via `pkg`;
   set up a Ubuntu proot rootfs with an official Node 22 build (Termux's own
   Node leaks in and breaks native modules — see gotchas below).
3. Copy `termux-scripts/*` to `~/server/` on the phone, `ai-gateway/*` to
   `~/server/ai-gateway/`, then `npm install` inside the proot environment
   (not Termux's own node).
4. Write a phone-side `~/server/.env` with just `DUCKDNS_DOMAIN` and
   `DUCKDNS_TOKEN` — `duckdns-updater.sh` sources it.
5. `pm2 start ecosystem.config.js && pm2 save`.
6. Install the Termux:Boot APK and drop `boot-start-server.sh` into
   `~/.termux/boot/start-server.sh` for auto-start on reboot.

## Load-bearing gotchas (learned the hard way — don't re-discover these)

- **`env -i` in every `start-*.sh` is required but dangerous.** A leaked
  Termux Node (v24) breaks native modules (`better-sqlite3`, `sqlite3`) if it
  gets into PATH ahead of the proot's Node 22. But `env -i` also wipes every
  other env var — each tunable must be forwarded explicitly
  (`VAR="${VAR:-}"`), or it silently falls back to its default.
- **A `llama-server` spawned from a short-lived `proot-distro login --` call
  freezes** once that invocation's tracer exits — port stays bound, `/health`
  never answers. It must be spawned as a child of a long-lived process
  (`ai-gateway`'s `llama.js`), never from a one-shot login.
- **`pkill -f "llama-server..."` can kill your own SSH session** if the
  pattern matches your current command line. Use the bracket trick:
  `pkill -f "[l]lama-server"`.
- **n8n v2's IF node (typeVersion 2.2) needs `combinator` inside
  `conditions`**, not as a sibling — otherwise `isFilterValue` returns the
  raw object (always truthy) and every branch routes to `true`.
- **n8n's Telegram node was unusable** for the approve/reject buttons
  (`inlineKeyboard` validation bug) — the workflow calls
  `api.telegram.org` directly via HTTP Request nodes instead.
- **NODE_OPTIONS=--dns-result-order=ipv4first** is required in
  `start-n8n.sh` — some WiFi networks advertise IPv6 that blackholes
  upstream, and n8n's HTTP client has no Happy-Eyeballs fallback.
- **GGUF embedding models**: check `tokenizer.ggml.model` is `"t5"` before
  downloading a multilingual-e5 GGUF — a `"bert"` (WordPiece) tokenizer over
  a SentencePiece vocab loads fine but maps every out-of-vocab word to one
  id, silently producing near-identical embeddings.
- Full incident history and deeper detail lived in Claude Code memory
  (`pocket-vps-setup.md`, `review-bot-status.md`) before this repo existed —
  worth migrating the rest over if this doc proves useful.

## Secrets

Never commit `.env`. See `.gitignore` — it also excludes certs, the n8n
credential store/DB, workflow backups that had tokens baked in, and large
binaries. `.env.example` is the template that should always stay in sync
with what the scripts actually expect.

## About this public copy

This is a cleaned copy of a private client project (T3 Thakali & Multi Food Gallery).
The scraped review corpus, reply pairs and generated reports are **not included**, to protect
customers' and the client's data, so the scraper and RAG-ingest scripts show the pipeline but need
your own data to run. Domains and instance URLs are replaced with placeholders.

## Security notes
- Telegram approvals are restricted to a single approver ID (set yours in the workflow). The demo's *incoming-message* parser does not check the sender, so before exposing the bot publicly, drop updates from any chat other than the approver.
- Helper scripts call n8n over plain HTTP on the home LAN; use HTTPS (Caddy) if you reach n8n from outside the network.
