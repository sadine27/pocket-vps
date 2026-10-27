const { getWorkflow, req } = require('./n8n-client');
const redact = (s) => String(s).replace(/\d{8,}:[A-Za-z0-9_-]{30,}/g, '<TOKEN>');
(async function () {
  const wf = await getWorkflow(process.env.WF_ID || 'ELk9R3m7jeGK5VAF');
  ['Build Msg', 'Send Draft', 'Is Authorized', 'Send Final'].forEach((nm) => {
    const n = wf.nodes.find((x) => x.name === nm);
    if (!n) return console.log('\n=== ' + nm + ': NOT FOUND');
    console.log('\n=== ' + nm + '  [' + n.type + ' v' + n.typeVersion + ']');
    console.log(redact(JSON.stringify(n.parameters, null, 2)));
  });
  console.log('\n=== ALL WORKFLOWS');
  const all = await req('GET', '/workflows?limit=50');
  (all.data || []).forEach((w) => console.log('  ' + (w.active ? 'ACTIVE  ' : 'inactive') + ' ' + w.id + '  ' + w.name));
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
