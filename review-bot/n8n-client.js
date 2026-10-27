// n8n-client.js — minimal n8n REST helper that survives a flaky link.
//
// The office WiFi drops TCP connections to the phone at random, so every call retries
// with a short backoff instead of failing the whole script. Exported for the patch
// scripts; run directly to dump a workflow to a file.
//
//   node n8n-client.js <workflowId> [outFile]
const fs = require('fs');
const path = require('path');
const https = require('https');

const HOST = process.env.N8N_HOST || 'YOUR-SUBDOMAIN.duckdns.org';
const PORT = Number(process.env.N8N_PORT || 8443);
const KEY = fs.readFileSync(path.join(__dirname, 'n8n-api-key.txt'), 'utf8').trim();
const RETRIES = Number(process.env.N8N_RETRIES || 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      host: HOST, port: PORT, path: '/n8n/api/v1' + p, method,
      // The phone serves a real Let's Encrypt cert for this hostname, so TLS verifies
      // normally even though DuckDNS points at a LAN address. Set N8N_INSECURE_TLS=1
      // only if the cert has lapsed, and fix the cert rather than leaving it set.
      rejectUnauthorized: process.env.N8N_INSECURE_TLS !== '1', timeout: 45000,
      headers: Object.assign({ 'X-N8N-API-KEY': KEY, Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(method + ' ' + p + ' -> ' + res.statusCode + ' ' + s.slice(0, 200)));
        if (!s) return reject(new Error(method + ' ' + p + ' -> empty body'));
        try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('bad JSON: ' + s.slice(0, 150))); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('socket timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function req(method, p, body) {
  let last;
  for (let i = 1; i <= RETRIES; i++) {
    try { return await once(method, p, body); } catch (e) {
      last = e;
      // A 4xx is a real answer from n8n and will not fix itself by retrying.
      if (/-> 4\d\d /.test(e.message)) throw e;
      process.stderr.write('  attempt ' + i + '/' + RETRIES + ' failed: ' + e.message + '\n');
      if (i < RETRIES) await sleep(2500);
    }
  }
  throw last;
}

const getWorkflow = (id) => req('GET', '/workflows/' + id);
// PUT accepts only these four keys; sending the whole object back is rejected.
const putWorkflow = (id, wf) => req('PUT', '/workflows/' + id, {
  name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {},
});

module.exports = { req, getWorkflow, putWorkflow };

if (require.main === module) {
  const id = process.argv[2];
  if (!id) { console.error('usage: node n8n-client.js <workflowId> [outFile]'); process.exit(1); }
  getWorkflow(id).then((w) => {
    const out = process.argv[3];
    if (out) { fs.writeFileSync(out, JSON.stringify(w, null, 2)); console.log('wrote ' + out); }
    console.log(w.name + ' | nodes: ' + w.nodes.length + ' | active: ' + w.active);
  }).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
