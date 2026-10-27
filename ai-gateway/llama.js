// llama.js — process manager for the two llama-server models (shared by server.js + ingest.js)
// Both binaries are Termux-native (bionic). Spawn them ONLY as children of this
// long-lived proot process: if the tracing proot exits, its children freeze —
// port stays bound but /health dies (see clearFrozen recovery in ensureModel).
// RAM guard: never run chat + embed at once when memory is tight (MIN_FREE_MB).
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');

const LLAMA_BIN = '/data/data/com.termux/files/usr/bin/llama-server';
const MODELS_DIR = '/data/data/com.termux/files/home/server/llama/models';
const PKILL = '/data/data/com.termux/files/usr/bin/pkill';
const LOG_DIR = '/data/data/com.termux/files/home/server/ai-gateway/logs';

const MODELS = {
  chat: {
    port: 8081,
    args: [
      '-m', MODELS_DIR + '/Qwen3.5-4B-Q4_K_M.gguf',
      '--host', '127.0.0.1', '--port', '8081',
      '-c', '2048', '-t', '4', '-b', '128',
      '--no-webui', '-np', '1', '--alias', 'qwen3.5-4b',
      '--reasoning', 'off', // REQUIRED: Qwen3.5 thinks by default and burns the token budget
    ],
    readyMs: 60000,
    idleMs: () => Number(process.env.IDLE_KILL_MS_CHAT || process.env.IDLE_KILL_MS || 15 * 60 * 1000),
  },
  embed: {
    port: 8084,
    args: [
      // multilingual-e5-small: 384-dim, XLM-R vocab (Devanagari + romanized + Hindi).
      // Must be a build whose tokenizer.ggml.model is "t5" (SentencePiece/UGM) — the
      // other GGUF uploads of this same model declare "bert" (WordPiece), which loads
      // fine but maps every out-of-vocab word onto one id, so unrelated reviews get
      // byte-identical embeddings. Verify with embed-sanity.js before trusting a swap.
      '-m', MODELS_DIR + '/e5-small-t5tok.gguf',
      '--host', '127.0.0.1', '--port', '8084',
      '--embedding', '--no-webui',
      // -b/-ub must clear the LONGEST review in one physical batch or llama-server
      // rejects it outright ("input (92 tokens) is too large to process"). The 24
      // synthetic sample pairs were short enough to hide this; real Google reviews
      // run past 600 characters. e5-small maxes out at 512 tokens anyway, so sizing
      // all three to 512 costs a few MB and removes the ceiling.
      '-c', '512', '-t', '2', '-b', '512', '-ub', '512',
      '--alias', 'e5-small',
    ],
    readyMs: 45000,
    idleMs: () => Number(process.env.IDLE_KILL_MS_EMBED || process.env.IDLE_KILL_MS || 15 * 60 * 1000),
  },
};

const state = {
  chat: { proc: null, lastUse: 0, inflight: null },
  embed: { proc: null, lastUse: 0, inflight: null },
};

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

function log(...a) { console.log(new Date().toISOString(), ...a); }

// Android's /proc hides other processes' cmdlines, so free -m is the reliable metric.
function freeMemMb() {
  try {
    const out = execSync('free -m', { encoding: 'utf8' });
    const line = out.split('\n')[1];
    if (!line) return null;
    const cols = line.trim().split(/\s+/); // total used free shared buff/cache available
    return Number(cols[6]);
  } catch (e) { return null; }
}

async function isAlive(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: ctl.signal });
    clearTimeout(t);
    return r.ok && (await r.text()).includes('ok');
  } catch (e) { return false; }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function waitHealthy(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Frozen orphan = llama whose tracing proot session died: TCP port bound, /health dead.
// Termux's pkill can match cmdlines of same-uid processes even from inside proot.
async function clearFrozen(port) {
  try {
    execSync(PKILL + ' -9 -f "llama-server.*--port ' + port + '"', { stdio: 'ignore' });
  } catch (e) { /* nothing matched — that's fine */ }
  await new Promise((r) => setTimeout(r, 800));
}

function killProc(kind) {
  const st = state[kind];
  if (!st.proc) return;
  const p = st.proc;
  st.proc = null;
  log(kind + ': sending SIGTERM');
  try { p.kill('SIGTERM'); } catch (e) {}
  setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 8000);
}

function spawnModel(kind) {
  const st = state[kind];
  const fd = fs.openSync(LOG_DIR + '/llama-' + kind + '.log', 'a');
  const proc = spawn(LLAMA_BIN, MODELS[kind].args, { stdio: ['ignore', fd, fd] });
  st.proc = proc;
  log(kind + ': spawned pid ' + proc.pid);
  proc.on('exit', (code) => {
    if (st.proc === proc) st.proc = null;
    log(kind + ': exited code ' + code);
  });
  proc.on('error', (e) => { log(kind + ': spawn error ' + e.message); });
  return proc;
}

// Returns true when the model answers /health. Serializes concurrent callers via
// state.inflight so two requests can't double-spawn.
async function ensureModel(kind) {
  const st = state[kind];
  st.lastUse = Date.now();
  const port = MODELS[kind].port;
  if (await isAlive(port)) return true; // healthy — may be pm2-owned, just use it
  if (st.inflight) return st.inflight;
  st.inflight = (async () => {
    const other = kind === 'chat' ? 'embed' : 'chat';
    const free = freeMemMb();
    if (free !== null && free < Number(process.env.MIN_FREE_MB || 1500) && state[other].proc) {
      log('RAM tight (' + free + 'MB avail), killing ' + other + ' before ' + kind);
      killProc(other);
    }
    if (await portBusy(port)) {
      if (await isAlive(port)) return true;
      log(kind + ': port ' + port + ' bound but dead — clearing frozen orphan');
      await clearFrozen(port);
    }
    spawnModel(kind);
    if (!(await waitHealthy(port, MODELS[kind].readyMs))) {
      log(kind + ': failed to become healthy, killing');
      killProc(kind);
      throw new Error('failed to start ' + kind + ' model (port ' + port + ')');
    }
    log(kind + ': ready');
    return true;
  })().finally(() => { st.inflight = null; });
  return st.inflight;
}

// Periodic idle-kill: models that nothing has asked for recently release their RAM.
function startIdleLoop() {
  const loop = () => {
    for (const kind of ['chat', 'embed']) {
      const st = state[kind];
      if (st.proc && Date.now() - st.lastUse > MODELS[kind].idleMs()) {
        log(kind + ': idle ' + Math.round((Date.now() - st.lastUse) / 1000) + 's — killing to free RAM');
        killProc(kind);
      }
    }
  };
  const t = setInterval(loop, 60000);
  if (t.unref) t.unref();
}

module.exports = { MODELS, state, log, freeMemMb, isAlive, ensureModel, killProc, startIdleLoop };
