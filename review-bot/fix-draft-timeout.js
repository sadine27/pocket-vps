// fix-draft-timeout.js — raise the LLM node's HTTP timeout on the live workflow.
//
// Why: the draft node was set to timeout: 120000 (2 minutes). Qwen3.5-4B on the phone's
// CPU has to process a prompt carrying eight retrieved examples and then generate ~180
// tokens, and the examples got longer once the corpus stopped being truncated. Two
// minutes is not enough, so n8n aborts the request and the workflow takes its
// draft_failed branch - which is exactly the message that arrived on Telegram.
//
// Divyesh's standing instruction is that latency does not matter ("let the entire
// automation run take an hour"), so the timeout is raised to 15 minutes. The node keeps
// its onError branch, so a genuinely dead gateway still surfaces the raw review rather
// than hanging the workflow.
//
// Usage: node fix-draft-timeout.js [minutes]
const fs = require('fs');
const path = require('path');
const https = require('https');

const MINUTES = Number(process.argv[2] || 15);
const TIMEOUT_MS = MINUTES * 60 * 1000;
const WF = process.env.WF_ID || 'ELk9R3m7jeGK5VAF';
const HOST = process.env.N8N_HOST || 'YOUR-SUBDOMAIN.duckdns.org';
const PORT = Number(process.env.N8N_PORT || 8443);
const KEY = fs.readFileSync(path.join(__dirname, 'n8n-api-key.txt'), 'utf8').trim();

const req = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = https.request({
    host: HOST, port: PORT, path: '/n8n/api/v1' + p, method,
    // The phone serves a real Let's Encrypt cert for this hostname, so TLS verifies
    // normally even though DuckDNS points at a LAN address. Set N8N_INSECURE_TLS=1 only
    // if the cert has lapsed, and fix the cert rather than leaving it set.
    rejectUnauthorized: process.env.N8N_INSECURE_TLS !== '1', timeout: 30000,
    headers: Object.assign({ 'X-N8N-API-KEY': KEY, Accept: 'application/json' },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
  }, (res) => {
    let s = '';
    res.on('data', (d) => { s += d; });
    res.on('end', () => {
      if (res.statusCode >= 400) return reject(new Error(method + ' ' + p + ' -> ' + res.statusCode + ' ' + s.slice(0, 300)));
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('bad JSON from ' + p + ': ' + s.slice(0, 200))); }
    });
  });
  r.on('timeout', () => r.destroy(new Error('request timed out')));
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});

// A node counts as the draft call if it POSTs to a chat-completions endpoint, whether
// that is llama-server directly on :8081 or the ai-gateway proxy on :8082.
const isDraftNode = (nd) =>
  nd.type === 'n8n-nodes-base.httpRequest' &&
  /chat\/completions/i.test(String((nd.parameters || {}).url || ''));

(async function () {
  const wf = await req('GET', '/workflows/' + WF);
  const nodes = wf.nodes || [];
  console.log('workflow: ' + wf.name + ' | nodes: ' + nodes.length + ' | active: ' + wf.active);

  const targets = nodes.filter(isDraftNode);
  if (!targets.length) { console.error('no chat-completions node found - nothing changed'); process.exit(1); }

  for (const nd of targets) {
    nd.parameters.options = nd.parameters.options || {};
    const was = nd.parameters.options.timeout;
    nd.parameters.options.timeout = TIMEOUT_MS;
    console.log('  ' + nd.name + ': timeout ' + (was == null ? '(unset)' : was + 'ms') + ' -> ' + TIMEOUT_MS + 'ms (' + MINUTES + ' min)');
    console.log('    url: ' + nd.parameters.url + ' | onError: ' + (nd.onError || '(default)'));
  }

  // PUT accepts only these four keys; sending the whole object back is rejected.
  await req('PUT', '/workflows/' + WF, {
    name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {},
  });
  console.log('saved. re-reading to confirm...');

  const after = await req('GET', '/workflows/' + WF);
  for (const nd of (after.nodes || []).filter(isDraftNode)) {
    console.log('  confirmed ' + nd.name + ' = ' + ((nd.parameters.options || {}).timeout) + 'ms');
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
