// patch-gguf.js — add new-format bert.* keys to an old BERT GGUF (pure Node, no deps)
// llama.cpp 2025+ requires bert.context_length / bert.pooling_type /
// bert.attention.causal etc.; 2024-era BERT GGUFs only carry the old names.
// Rewrites: header (kvCount+5) + old KVs + 5 new KVs + tensor infos (offsets
// shifted by a 64-byte-aligned delta) + untouched tensor data. Original untouched.
// Usage: node patch-gguf.js <input.gguf> <output.gguf>
const fs = require('fs');
const [src, dst] = process.argv.slice(2);

const buf = fs.readFileSync(src);
if (buf.toString('utf8', 0, 4) !== 'GGUF') throw new Error('not a GGUF file');
const version = buf.readUInt32LE(4);
const tensorCount = Number(buf.readBigUInt64LE(8));
const kvCount = Number(buf.readBigUInt64LE(16));
let off = 24;

// 2025 GGUF spec enum: BOOL=7, STRING=8 (swapped vs pre-2025 files)
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12, U128: 13, I128: 14 };
const SZ = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8, 13: 16, 14: 16 };
const READ = { 0: 'readUInt8', 1: 'readInt8', 2: 'readUInt16LE', 3: 'readInt16LE', 4: 'readUInt32LE', 5: 'readInt32LE', 6: 'readFloatLE', 7: 'readUInt8', 10: 'readBigUInt64LE', 11: 'readBigInt64LE', 12: 'readDoubleLE' };

function readStr() {
  const len = Number(buf.readBigUInt64LE(off)); off += 8;
  const s = buf.toString('utf8', off, off + len); off += len;
  return s;
}

// skip one value of the given type (arrays may contain strings or nested arrays)
function skipValue(vt) {
  if (vt === T.STR) {
    const l = Number(buf.readBigUInt64LE(off)); off += 8 + l;
  } else if (vt === T.ARR) {
    const et = buf.readUInt32LE(off); off += 4;
    const n = Number(buf.readBigUInt64LE(off)); off += 8;
    for (let i = 0; i < n; i++) skipValue(et);
  } else {
    off += SZ[vt];
  }
}

// pass 1: existing KVs (values of old bert.* keys) + end of KV section
const old = {};
const allKeys = [];
let tokensInfo = null;
for (let i = 0; i < kvCount; i++) {
  const key = readStr();
  const vt = buf.readUInt32LE(off); off += 4;
  allKeys.push(key + ' (t' + vt + ')');
  if (vt === T.STR) {
    const len = Number(buf.readBigUInt64LE(off)); off += 8;
    old[key] = buf.toString('utf8', off, off + len); off += len;
  } else if (vt === T.ARR) {
    const et = buf.readUInt32LE(off); off += 4;
    const n = Number(buf.readBigUInt64LE(off)); off += 8;
    if (key === 'tokenizer.ggml.tokens' && et === T.STR) tokensInfo = { dataStart: off, n };
    for (let i = 0; i < n; i++) skipValue(et);
  } else {
    old[key] = buf[READ[vt]].call(buf, off);
    off += SZ[vt];
  }
}

// synthesize the per-token type array the old converter never wrote:
// control(3) for <s>/<pad>/</s>/<mask>, unknown(2) for <unk>, normal(1) otherwise
function buildTokenTypes() {
  const arr = Buffer.alloc(4 * tokensInfo.n);
  const SPECIAL = { '<s>': 3, '<pad>': 3, '</s>': 3, '<mask>': 3, '<unk>': 2 };
  let p = tokensInfo.dataStart;
  for (let i = 0; i < tokensInfo.n; i++) {
    const len = Number(buf.readBigUInt64LE(p)); p += 8;
    const tok = buf.toString('utf8', p, p + len); p += len;
    arr.writeUInt32LE(SPECIAL[tok] || 1, 4 * i);
  }
  return arr;
}
const typeArr = tokensInfo ? buildTokenTypes() : Buffer.alloc(0);
const kvEnd = off;
console.log('old bert keys:', JSON.stringify(Object.fromEntries(Object.entries(old).filter(([k]) => k.startsWith('bert.')))));

if (process.argv.includes('--dump')) {
  console.log('ALL KV KEYS:', allKeys.join(' | '));
  console.log('STRING VALUES:', JSON.stringify(Object.fromEntries(
    Object.entries(old).filter(([, v]) => typeof v === 'string'))));
  console.log('tensor names (dims x type @ offset):');
  for (let i = 0; i < tensorCount; i++) {
    const name = readStr();
    const nDims = buf.readUInt32LE(off); off += 4;
    const dims = [];
    for (let d = 0; d < nDims; d++) { dims.push(Number(buf.readBigUInt64LE(off))); off += 8; }
    const t = buf.readUInt32LE(off); off += 4;
    const toff = Number(buf.readBigUInt64LE(off)); off += 8;
    console.log(i, name, JSON.stringify(dims), 't' + t, '@' + toff);
  }
  process.exit(0);
}

// pass 2: tensor infos — reserialize with llama.cpp's LLM_ARCH_BERT tensor names.
// BERT is POST-norm: ln1 is attention.output.LayerNorm and ln2 is output.LayerNorm,
// so they map to attn_output_norm / layer_output_norm — NOT the attn_norm/ffn_norm
// pre-norm names used by LLaMA-style archs (those don't exist in the BERT table).
// Offsets stay untouched (they are relative to the data section).
function renameTensor(name) {
  // token_embd.weight and position_embd.weight keep their names in the 2025 loader
  if (name === 'token_type_embd.weight') return 'token_types.weight';
  if (name === 'embd_ln.weight') return 'token_embd_norm.weight';
  if (name === 'embd_ln.bias') return 'token_embd_norm.bias';
  // the unused mean-pooling model still ships BERT's pooler dense [384,384]+[384];
  // llama.cpp fails unless every tensor is claimed, and LLM_TENSOR_CLS matches that
  // exact shape (optional, unused under pooling_type=MEAN) — park them there.
  if (name === 'pooler.weight') return 'cls.weight';
  if (name === 'pooler.bias') return 'cls.bias';
  // LN_SWAP=1 flips which of ln1/ln2 is the post-attention vs post-FFN norm.
  // BERT has exactly two LayerNorms per layer, so this is one bit — decided by
  // measuring embedding quality both ways rather than trusting the file ordering.
  const N1 = process.env.LN_SWAP ? 'layer_output_norm' : 'attn_output_norm';
  const N2 = process.env.LN_SWAP ? 'attn_output_norm' : 'layer_output_norm';
  let m = name.match(/^enc\.(\d+)\.ln1\.(weight|bias)$/);
  if (m) return 'blk.' + m[1] + '.' + N1 + '.' + m[2];
  m = name.match(/^enc\.(\d+)\.attn\.([qkv])\.(weight|bias)$/);
  if (m) return 'blk.' + m[1] + '.attn_' + m[2] + '.' + m[3];
  m = name.match(/^enc\.(\d+)\.attn\.o\.(weight|bias)$/);
  if (m) return 'blk.' + m[1] + '.attn_output.' + m[2];
  m = name.match(/^enc\.(\d+)\.ln2\.(weight|bias)$/);
  if (m) return 'blk.' + m[1] + '.' + N2 + '.' + m[2];
  m = name.match(/^enc\.(\d+)\.ffn\.fc1\.(weight|bias)$/);
  if (m) return 'blk.' + m[1] + '.ffn_up.' + m[2];
  m = name.match(/^enc\.(\d+)\.ffn\.fc2\.(weight|bias)$/);
  if (m) return 'blk.' + m[1] + '.ffn_down.' + m[2];
  return name;
}
const ti = [];
let nTokenTypes = 0;
for (let i = 0; i < tensorCount; i++) {
  const name = readStr();
  const nDims = buf.readUInt32LE(off); off += 4;
  const dims = [];
  for (let d = 0; d < nDims; d++) { dims.push(Number(buf.readBigUInt64LE(off))); off += 8; }
  const gtype = buf.readUInt32LE(off); off += 4;
  const toff = Number(buf.readBigUInt64LE(off)); off += 8;
  // type_embd is created as {n_embd, n_token_types}: the count KV must match dims[1]
  if (name === 'token_type_embd.weight' || name === 'token_types.weight') nTokenTypes = dims[1] || 1;
  ti.push({ name: renameTensor(name), nDims, dims, gtype, toff });
}
const infoEnd = off;
const tiNew = Buffer.concat(ti.map((t) => {
  const nb = Buffer.from(t.name, 'utf8');
  const h1 = Buffer.alloc(8); h1.writeBigUInt64LE(BigInt(nb.length), 0);
  const h2 = Buffer.alloc(4); h2.writeUInt32LE(t.nDims, 0);
  const db = Buffer.alloc(8 * t.nDims);
  t.dims.forEach((d, i) => db.writeBigUInt64LE(BigInt(d), 8 * i));
  const h3 = Buffer.alloc(4); h3.writeUInt32LE(t.gtype, 0);
  const h4 = Buffer.alloc(8); h4.writeBigUInt64LE(BigInt(t.toff), 0);
  return Buffer.concat([h1, nb, h2, db, h3, h4]);
}));

// the new keys (llama.cpp bert model metadata migration)
// GGUF KV layout: [key_len u64][key bytes][value_type u32][value bytes]
function kvBytes(key, type, valBuf) {
  const kb = Buffer.from(key, 'utf8');
  const h = Buffer.alloc(8);
  h.writeBigUInt64LE(BigInt(kb.length), 0);
  const t = Buffer.alloc(4);
  t.writeUInt32LE(type, 0);
  return Buffer.concat([h, kb, t, valBuf]);
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n, 0); return b; };
const strV = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(b.length), 0); return Buffer.concat([h, b]); };
const additions = Buffer.concat([
  kvBytes('bert.context_length', T.U32, u32(Number(old['bert.max_position_embeddings'] || 512))),
  kvBytes('bert.embedding_length', T.U32, u32(Number(old['bert.output_dim'] || 384))),
  kvBytes('bert.pooling_type', T.U32, u32(1)), // MEAN = sentence-transformers default
  kvBytes('bert.attention.causal', T.BOOL, Buffer.from([0])),
  kvBytes('bert.attention.layer_norm_epsilon', T.F32, f32(Number(old['bert.layer_norm_eps'] || 1e-12))),
  kvBytes('bert.block_count', T.U32, u32(Number(old['bert.num_hidden_layers'] || 12))),
  kvBytes('bert.feed_forward_length', T.U32, u32(Number(old['bert.intermediate_size'] || 1536))),
  kvBytes('bert.attention.head_count', T.U32, u32(Number(old['bert.num_attention_heads'] || 12))),
  kvBytes('tokenizer.ggml.model', T.STR, strV('t5')), // XLM-R sentencepiece-unigram
  kvBytes('tokenizer.ggml.token_type', T.ARR, (() => {
    const et = Buffer.alloc(4); et.writeUInt32LE(T.U32, 0);
    const cnt = Buffer.alloc(8); cnt.writeBigUInt64LE(BigInt(tokensInfo.n), 0);
    return Buffer.concat([et, cnt, typeArr]);
  })()),
  // BERT segment-embedding count — must equal token_types.weight dims[1] (2 here),
  // not the size of llama.cpp's token-type enum. A mismatch is a load-time shape error.
  kvBytes('tokenizer.ggml.token_type_count', T.U32, u32(nTokenTypes || 2)),
]);

// Tensor offsets are relative to the data section, and the reader locates that
// section at alignUp(end-of-metadata, general.alignment). So the padding must be
// computed against the ABSOLUTE file offset (metadata starts at 24), not against
// the section length — padding the section to a multiple of 64 leaves the data at
// 24 (mod 32) and every tensor gets read 8 bytes off its real start. That decodes
// Q8_0 scale factors out of neighbouring bytes: the model loads, runs, and emits
// NaN. Strip the original padding, then re-pad to the true alignment.
const ALIGN = Number(old['general.alignment'] || 32);
const alignUp = (n) => n + ((ALIGN - (n % ALIGN)) % ALIGN);
const origDataStart = alignUp(infoEnd);
const data = buf.subarray(origDataStart);

const section = Buffer.concat([buf.subarray(24, kvEnd), additions, tiNew]);
const metaEnd = 24 + section.length;
const newDataStart = alignUp(metaEnd);
const pad = newDataStart - metaEnd;

const head = Buffer.alloc(24);
head.write('GGUF', 0, 'utf8');
head.writeUInt32LE(version, 4);
head.writeBigUInt64LE(BigInt(tensorCount), 8);
head.writeBigUInt64LE(BigInt(kvCount + 11), 16);
fs.writeFileSync(dst, Buffer.concat([head, section, Buffer.alloc(pad), data]));
console.log('wrote', dst, '| kvCount', kvCount, '+11 | tensors', tensorCount,
  '| align', ALIGN, '| dataStart', origDataStart, '->', newDataStart, '| pad', pad);

// self-check: every tensor must end inside the data section, and the last one must
// end exactly at EOF. This is what catches an off-by-alignment data section.
const BLK = { 0: [1, 4], 1: [1, 2], 8: [32, 34] }; // ggml type -> [elems/block, bytes/block]
let maxEnd = 0;
for (const t of ti) {
  const [be, bb] = BLK[t.gtype] || [1, 4];
  const n = t.dims.reduce((a, b) => a * b, 1);
  maxEnd = Math.max(maxEnd, t.toff + (n / be) * bb);
}
const dataLen = fs.statSync(dst).size - newDataStart;
console.log('tensor data span', maxEnd, '| data section', dataLen,
  maxEnd === dataLen ? '(exact)' : '(MISMATCH by ' + (dataLen - maxEnd) + ')');
if (maxEnd !== dataLen) throw new Error('data section size mismatch — alignment is wrong');

// self-check: re-parse the output and dump its bert.* keys
const b2 = fs.readFileSync(dst);
if (b2.toString('utf8', 0, 4) !== 'GGUF') throw new Error('output magic broken');
const k2 = Number(b2.readBigUInt64LE(16));
let o2 = 24;
function skip2(vt) {
  if (vt === T.STR) { const l = Number(b2.readBigUInt64LE(o2)); o2 += 8 + l; }
  else if (vt === T.ARR) {
    const et = b2.readUInt32LE(o2); o2 += 4;
    const n = Number(b2.readBigUInt64LE(o2)); o2 += 8;
    for (let i = 0; i < n; i++) skip2(et);
  } else o2 += SZ[vt];
}
const got = {};
for (let i = 0; i < k2; i++) {
  const len = Number(b2.readBigUInt64LE(o2)); o2 += 8;
  const key = b2.toString('utf8', o2, o2 + len); o2 += len;
  const vt = b2.readUInt32LE(o2); o2 += 4;
  if (vt === T.STR) { const l = Number(b2.readBigUInt64LE(o2)); o2 += 8 + l; }
  else if (vt === T.ARR) { const et = b2.readUInt32LE(o2); o2 += 4; const n = Number(b2.readBigUInt64LE(o2)); o2 += 8; for (let i = 0; i < n; i++) skip2(et); }
  else { got[key] = b2[READ[vt]].call(b2, o2); o2 += SZ[vt]; }
}
console.log('new bert keys:', JSON.stringify(Object.fromEntries(Object.entries(got).filter(([k]) => k.startsWith('bert.')))));
console.log('PATCH_OK');
