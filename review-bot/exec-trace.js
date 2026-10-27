// exec-trace.js — show the last N executions of the workflow with per-node item counts.
//
//   node exec-trace.js [count]
const { req } = require('./n8n-client');

const WF = process.env.WF_ID || 'ELk9R3m7jeGK5VAF';
const N = Number(process.argv[2] || 6);
const redact = (s) => String(s).replace(/\d{8,}:[A-Za-z0-9_-]{30,}/g, '<TOKEN>');
const npt = (iso) => new Date(new Date(iso).getTime() + (5 * 60 + 45) * 60000).toISOString().slice(11, 19);

(async function () {
  const list = await req('GET', '/executions?workflowId=' + WF + '&limit=' + N + '&includeData=false');
  const rows = (list.data || []);
  for (const row of rows) {
    const full = await req('GET', '/executions/' + row.id + '?includeData=true');
    const rd = (full.data && full.data.resultData) || {};
    const dur = full.stoppedAt ? ((new Date(full.stoppedAt) - new Date(full.startedAt)) / 1000).toFixed(0) : '?';
    console.log('\n=== exec ' + row.id + ' | ' + full.status + ' | Nepal ' + npt(full.startedAt) + ' | ' + dur + 's');
    if (rd.error) console.log('   ERROR: ' + redact(rd.error.message || '').slice(0, 200));
    for (const name of Object.keys(rd.runData || {})) {
      const runs = rd.runData[name] || [];
      runs.forEach(function (r) {
        const items = ((r.data && r.data.main && r.data.main[0]) || []).length;
        let extra = '';
        const first = (r.data && r.data.main && r.data.main[0] && r.data.main[0][0] && r.data.main[0][0].json) || null;
        if (first) {
          if (first.offset !== undefined) extra = ' offset=' + first.offset;
          if (first.update_id !== undefined) extra = ' update_id=' + first.update_id;
          if (first.action !== undefined) extra = ' action=' + first.action + ' authorized=' + first.authorized;
          if (first.ok !== undefined && first.result && first.result.length !== undefined) extra = ' tg_result=' + first.result.length;
        }
        console.log('   ' + name.padEnd(18) + ' ' + String(r.executionStatus).padEnd(8) + ' items=' + items + ' (' + r.executionTime + 'ms)' + extra);
        if (r.error) console.log('        err: ' + redact(r.error.message || '').slice(0, 160));
      });
    }
  }
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
