// ai-gateway :8082 — RAG + LLM sidecar (runs in proot Ubuntu, Node 22)
// Endpoints:
//   GET  /health               -> {ok, chat_alive, embed_alive, free_mem_mb, ...}
//   GET  /v1/models            -> OpenAI-style model list (n8n OpenAI node compat)
//   POST /v1/chat/completions  -> proxy to llama chat :8081 (spawns on demand)
//   POST /search {text,k,business_id} -> embed via :8084 + sqlite-vec kNN -> top pairs
const http = require('http');
const llama = require('./llama');
const rag = require('./db');

const PORT = Number(process.env.PORT || 8082);

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 10_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

async function handleSearch(res, body) {
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { error: 'text required' });
  const k = Math.max(1, Math.min(Number(body.k) || 8, 64));
  await llama.ensureModel('embed');
  const emb = await fetch('http://127.0.0.1:8084/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: rag.asQuery(text), model: 'e5-small' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!emb.ok) throw new Error('embed call failed: ' + emb.status);
  const ej = await emb.json();
  const vec = ej.data && ej.data[0] && ej.data[0].embedding;
  if (!vec || vec.length !== rag.DIMS) throw new Error('bad embedding dims');
  const pairs = rag.search(vec, k, body.business_id || null);
  return json(res, 200, { query: text, pairs });
}

async function handleChat(res, body) {
  if (body.stream) return json(res, 400, { error: 'streaming not supported; use stream:false' });
  if (!body.messages || !body.messages.length) return json(res, 400, { error: 'messages required' });
  await llama.ensureModel('chat');
  const r = await fetch('http://127.0.0.1:8081/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: false }),
    signal: AbortSignal.timeout(600000),
  });
  const text = await r.text();
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/health') {
      const [chatAlive, embedAlive, free] = await Promise.all([
        llama.isAlive(8081), llama.isAlive(8084), Promise.resolve(llama.freeMemMb()),
      ]);
      return json(res, 200, {
        ok: true,
        chat_alive: chatAlive,
        embed_alive: embedAlive,
        chat_owned: !!llama.state.chat.proc,
        embed_owned: !!llama.state.embed.proc,
        free_mem_mb: free,
        uptime_s: Math.floor(process.uptime()),
      });
    }
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: 'qwen3.5-4b', object: 'model' }] });
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      return await handleChat(res, JSON.parse((await readBody(req)) || '{}'));
    }
    if (req.method === 'POST' && u.pathname === '/search') {
      return await handleSearch(res, JSON.parse((await readBody(req)) || '{}'));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
});

process.on('SIGINT', () => { llama.killProc('chat'); llama.killProc('embed'); process.exit(0); });
process.on('SIGTERM', () => { llama.killProc('chat'); llama.killProc('embed'); process.exit(0); });
process.on('uncaughtException', (e) => { llama.log('uncaughtException:', e && e.stack || e); });

llama.startIdleLoop();
server.listen(PORT, '127.0.0.1', () => llama.log('ai-gateway listening on 127.0.0.1:' + PORT));
