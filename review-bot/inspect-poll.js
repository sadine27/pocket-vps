// inspect-poll.js — dump the approval-path nodes of the live workflow, token redacted.
//
// The workflow stores the bot token inside Telegram API URLs, so every line is passed
// through redact() before printing.
const { getWorkflow } = require('./n8n-client');

const WF = process.env.WF_ID || 'ELk9R3m7jeGK5VAF';
const redact = (s) => String(s).replace(/\d{8,}:[A-Za-z0-9_-]{30,}/g, '<TOKEN>');

(async function () {
  const wf = await getWorkflow(WF);
  console.log(wf.name + ' | nodes ' + wf.nodes.length + ' | active ' + wf.active);
  console.log('\nALL NODES:');
  wf.nodes.forEach((n) => console.log('  - ' + n.name + '  [' + n.type.replace('n8n-nodes-base.', '') + ']'));

  const want = /poll|offset|update|callback|approve|reject|answer|claim|handled/i;
  wf.nodes.filter((n) => want.test(n.name)).forEach((n) => {
    console.log('\n=== ' + n.name + '  [' + n.type + ' v' + n.typeVersion + ']');
    console.log(redact(JSON.stringify(n.parameters, null, 2)).slice(0, 2500));
  });

  console.log('\n=== CONNECTIONS (approval path)');
  Object.keys(wf.connections).filter((k) => want.test(k)).forEach((k) => {
    const outs = (wf.connections[k].main || []).map((br) => (br || []).map((c) => c.node).join(', '));
    console.log('  ' + k + '  ->  ' + JSON.stringify(outs));
  });
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
