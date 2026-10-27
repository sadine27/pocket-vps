// tg-diag.js — look at Telegram's update queue WITHOUT consuming it.
//
// Why offset=-1: getUpdates(offset=N) confirms (permanently deletes) every update
// with id < N. offset=-1 asks only for the single most recent update and confirms
// nothing, so this is safe to run while a real button tap is sitting in the queue.
//
// The bot token is read from telegram-info.txt and never printed.
const fs = require('fs');
const path = require('path');
const https = require('https');

const raw = fs.readFileSync(path.join(__dirname, 'telegram-info.txt'), 'utf8');
const m = raw.match(/\b(\d{8,}:[A-Za-z0-9_-]{30,})\b/);
if (!m) { console.error('no bot token found in telegram-info.txt'); process.exit(1); }
const TOKEN = m[1];

const api = (method, qs) => new Promise((resolve, reject) => {
  https.get('https://api.telegram.org/bot' + TOKEN + '/' + method + (qs ? '?' + qs : ''), (res) => {
    let s = '';
    res.on('data', (d) => { s += d; });
    res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(s.slice(0, 200))); } });
  }).on('error', reject);
});

(async function () {
  const wh = (await api('getWebhookInfo')).result || {};
  console.log('webhook url      : ' + JSON.stringify(wh.url));
  console.log('pending updates  : ' + wh.pending_update_count);
  console.log('allowed_updates  : ' + JSON.stringify(wh.allowed_updates || '(default: all but chat_member)'));
  if (wh.last_error_message) console.log('last webhook error: ' + wh.last_error_message);

  const u = await api('getUpdates', 'offset=-1&limit=1&timeout=0');
  console.log('getUpdates ok    : ' + u.ok + ' | returned ' + ((u.result || []).length));
  if (!u.ok) console.log('  error          : ' + u.error_code + ' ' + u.description);
  (u.result || []).forEach(function (x) {
    console.log('  update_id      : ' + x.update_id);
    console.log('  type           : ' + Object.keys(x).filter((k) => k !== 'update_id').join(','));
    if (x.callback_query) {
      const c = x.callback_query;
      console.log('  callback data  : ' + c.data);
      console.log('  from id        : ' + c.from.id);
      console.log('  message id     : ' + (c.message && c.message.message_id));
      console.log('  chat id        : ' + (c.message && c.message.chat && c.message.chat.id));
      console.log('  tapped at      : ' + new Date((c.message ? c.message.date : 0) * 1000).toISOString());
    }
    if (x.message) console.log('  message text   : ' + String(x.message.text || '').slice(0, 60));
  });
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
