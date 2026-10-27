// fix-approval.js — make the Approve/Reject buttons actually respond.
//
// Evidence from executions 3725-3730 (2026-08-18):
//   * exec 3727 fetched update 115989631 (the review), drafted, and sent the buttons.
//   * exec 3728/3729/3730 each long-polled 10s at offset 115989632 and got NOTHING.
//   * getWebhookInfo's pending_update_count of 1 was update 115989631 awaiting
//     confirmation, not the tap: the offset store is written locally at Ack Offset but
//     only confirmed to Telegram by the NEXT getUpdates, which is exec 3728 at 20:50:34
//     -- precisely when pending dropped to 0.
// So no callback_query ever entered the queue. The keyboard itself is correct
// (inline_keyboard with approve_<rid> / reject_<rid>), so the wiring was never the
// problem. What IS broken is everything around it:
//
//   1. Poll TG runs every 5 minutes -> a tap waits up to 5 minutes for anyone to look.
//   2. Nothing ever calls answerCallbackQuery, so Telegram spins a loader on the
//      button and then shows an error, which looks identical to "nothing happened"
//      even on a tap that worked perfectly.
//   3. getUpdates never passes allowed_updates, so it silently inherits whatever was
//      set last -- today that includes callback_query, but nothing pins it there.
//   4. Buttons stay live forever after a decision, so a second tap re-runs everything.
//
// Fixes, in order: 1-minute schedule with a 50s long poll (a tap now surfaces within
// seconds, not minutes, at one execution per minute), an Answer Callback node that
// acks the tap immediately, allowed_updates pinned in the URL, and the keyboard
// cleared once a decision is recorded.
//
// Usage: node fix-approval.js
const fs = require('fs');
const path = require('path');
const { getWorkflow, putWorkflow } = require('./n8n-client');

const WF = process.env.WF_ID || 'ELk9R3m7jeGK5VAF';
const ALLOWED = encodeURIComponent(JSON.stringify(['message', 'callback_query']));

const HANDLE_CALLBACK = `const cb = $json.callback_query || {};
const data = cb.data || '';
const from = (cb.from && cb.from.id) || 0;
const msg = cb.message || {};
const msgText = msg.text || '';
const draftMatch = msgText.match(/Draft reply:\\n([\\s\\S]*)$/);
const unesc = function(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); };
const esc = function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
const draft = draftMatch ? unesc(draftMatch[1].trim()) : '';
const action = data.startsWith('approve_') ? 'approve' : (data.startsWith('reject_') ? 'reject' : 'unknown');
// A FAILED draft carries no "Draft reply:" section, so approving one would paste an
// empty reply onto Google. Say so instead.
let text;
if (action === 'approve') {
  text = draft ? '\\u2705 APPROVED \\u2014 paste this reply on Google:\\n\\n' + esc(draft)
               : '\\u26a0\\ufe0f That message had no draft to approve.';
} else if (action === 'reject') {
  text = '\\u274c Rejected \\u2014 nothing will be posted.';
} else {
  text = 'Unknown button.';
}
const toast = action === 'approve' ? (draft ? 'Approved \\u2705' : 'No draft on that one') : (action === 'reject' ? 'Rejected \\u274c' : 'Unknown button');
return [{ json: {
  action, from, draft, text, toast,
  chatId: msg.chat ? msg.chat.id : '',
  messageId: msg.message_id || 0,
  cbId: cb.id || '',
  authorized: from === YOUR_TELEGRAM_USER_ID,
  updateId: $json.update_id || 0
} }];`;

(async function () {
  const wf = await getWorkflow(WF);
  fs.writeFileSync(path.join(__dirname, 'demo-workflow.before-approval-fix.json'), JSON.stringify(wf, null, 2));
  const node = (n) => wf.nodes.find((x) => x.name === n);
  const log = [];

  // 1. Schedule: 5 minutes -> 1 minute.
  const poll = node('Poll TG');
  poll.parameters.rule.interval[0].minutesInterval = 1;
  log.push('Poll TG            : every 5 min -> every 1 min');

  // 2. getUpdates: 10s long poll -> 50s, and pin allowed_updates so it cannot drift.
  //    The node timeout has to outlast the long poll or n8n aborts mid-wait.
  const gu = node('Get Updates');
  const base = gu.parameters.url.replace(/\?[\s\S]*$/, '');
  gu.parameters.url = base + '?timeout=50&allowed_updates=' + ALLOWED + "&offset=' + ($json.offset + 1) }}";
  gu.parameters.options.timeout = 70000;
  log.push('Get Updates        : 10s -> 50s long poll, allowed_updates pinned, node timeout 30s -> 70s');

  // 3. Handle Callback: carry cbId + messageId so the tap can be acked and cleared.
  node('Handle Callback').parameters.jsCode = HANDLE_CALLBACK;
  log.push('Handle Callback    : now emits cbId, messageId, toast; guards an empty draft');

  // 4. New nodes. The token already lives in the sendMessage URL - reuse it rather
  //    than storing a second copy anywhere.
  const sendUrl = node('Send Draft').parameters.url;
  const hc = node('Handle Callback');
  const mk = (name, params, dx, dy) => ({
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [hc.position[0] + dx, hc.position[1] + dy],
    parameters: params,
    // An ack that fails must never block the actual decision.
    onError: 'continueRegularOutput',
  });

  if (!node('Answer Callback')) {
    wf.nodes.push(mk('Answer Callback', {
      method: 'POST',
      url: sendUrl.replace('/sendMessage', '/answerCallbackQuery'),
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ callback_query_id: $json.cbId, text: $json.toast }) }}',
      options: { timeout: 10000 },
    }, 180, -120));
    wf.nodes.push({
      name: 'Restore Callback',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [hc.position[0] + 360, hc.position[1] - 120],
      // Same trap as Ack Offset: the HTTP response replaced the item, so put the
      // parsed callback back before the authorization check reads it.
      parameters: { jsCode: "return $('Handle Callback').all();" },
    });
    log.push('Answer Callback    : NEW - acks the tap in <1s so the button stops spinning');
    log.push('Restore Callback   : NEW - restores item data after the ack HTTP node');
  }

  if (!node('Clear Buttons')) {
    wf.nodes.push(mk('Clear Buttons', {
      method: 'POST',
      url: sendUrl.replace('/sendMessage', '/editMessageReplyMarkup'),
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ chat_id: $('Handle Callback').item.json.chatId, message_id: $('Handle Callback').item.json.messageId, reply_markup: { inline_keyboard: [] } }) }}",
      options: { timeout: 10000 },
    }, 180, 200));
    log.push('Clear Buttons      : NEW - removes the keyboard once a decision is recorded');
  }

  // 5. Rewire: Handle Callback -> Answer Callback -> Restore Callback -> Is Authorized
  const c = wf.connections;
  c['Handle Callback'] = { main: [[{ node: 'Answer Callback', type: 'main', index: 0 }]] };
  c['Answer Callback'] = { main: [[{ node: 'Restore Callback', type: 'main', index: 0 }]] };
  c['Restore Callback'] = { main: [[{ node: 'Is Authorized', type: 'main', index: 0 }]] };
  c['Save Offset Ok'] = { main: [[{ node: 'Clear Buttons', type: 'main', index: 0 }]] };
  log.push('rewired            : Handle Callback -> Answer Callback -> Restore Callback -> Is Authorized');
  log.push('rewired            : Save Offset Ok -> Clear Buttons');

  console.log(wf.name + ' | nodes ' + wf.nodes.length + ' | active ' + wf.active);
  log.forEach((l) => console.log('  ' + l));
  console.log('  backup             : demo-workflow.before-approval-fix.json');

  await putWorkflow(WF, wf);

  const after = await getWorkflow(WF);
  const a = (n) => after.nodes.find((x) => x.name === n);
  const ok = a('Answer Callback') && a('Restore Callback') && a('Clear Buttons')
    && a('Poll TG').parameters.rule.interval[0].minutesInterval === 1
    && /timeout=50/.test(a('Get Updates').parameters.url)
    && a('Get Updates').parameters.options.timeout === 70000
    && after.connections['Restore Callback'].main[0][0].node === 'Is Authorized';
  console.log(ok
    ? '\nconfirmed: live workflow updated (' + after.nodes.length + ' nodes, active ' + after.active + ')'
    : '\nMISMATCH after save');
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
