// workers/log-worker.js
// Exclusive owner of the G log (immutable, append-only) backed by OPFS.
// Maintains a small secondary index (anchor → offsets, op → offsets) so we
// can answer queries without rescanning the whole file.

let fileHandle = null;
let accessHandle = null;
let index = {};     // anchor → [byte_offset, ...]
let opIndex = {};   // op     → [byte_offset, ...]
let byteLength = 0;

async function init() {
  const root = await navigator.storage.getDirectory();
  const corpus = await root.getDirectoryHandle('corpus', { create: true });
  fileHandle = await corpus.getFileHandle('g_log.ndjson', { create: true });
  // createSyncAccessHandle is only callable inside a Worker.
  accessHandle = await fileHandle.createSyncAccessHandle();
  byteLength = accessHandle.getSize();
  await loadIndex(corpus);
}

async function loadIndex(corpus) {
  try {
    const idxHandle = await corpus.getFileHandle('g_index.json');
    const file = await idxHandle.getFile();
    const parsed = JSON.parse(await file.text());
    index = parsed.anchor || {};
    opIndex = parsed.op || {};
  } catch { /* first run — no index yet */ }
}

async function flushIndex(corpus) {
  const idxHandle = await corpus.getFileHandle('g_index.json', { create: true });
  const w = await idxHandle.createWritable();
  await w.write(JSON.stringify({ anchor: index, op: opIndex }));
  await w.close();
}

function append(entry) {
  const line = JSON.stringify(entry) + '\n';
  const encoded = new TextEncoder().encode(line);
  const offset = byteLength;
  accessHandle.write(encoded, { at: offset });
  accessHandle.flush();
  byteLength += encoded.byteLength;

  const a = entry.anchor;
  if (a) {
    if (!index[a]) index[a] = [];
    index[a].push(offset);
  }
  const op = entry.op;
  if (op) {
    if (!opIndex[op]) opIndex[op] = [];
    opIndex[op].push(offset);
  }

  return { log_id: entry.log_id, offset };
}

function readAt(offset) {
  // Read forward from offset until newline. 64KB read buffer handles
  // entries larger than the initial 8KB the plan suggested.
  const buf = new Uint8Array(65536);
  const n = accessHandle.read(buf, { at: offset });
  const text = new TextDecoder().decode(buf.subarray(0, n));
  const line = text.split('\n')[0];
  try { return JSON.parse(line); } catch { return null; }
}

function queryByAnchor(anchor) {
  const offsets = index[anchor] || [];
  return offsets.map(readAt).filter(Boolean);
}

function queryByOp(op) {
  const offsets = opIndex[op] || [];
  return offsets.map(readAt).filter(Boolean);
}

function scanAll(callback) {
  if (byteLength === 0) return;
  const buf = new Uint8Array(byteLength);
  accessHandle.read(buf, { at: 0 });
  const text = new TextDecoder().decode(buf);
  const lines = text.split('\n').filter(l => l.trim());
  lines.forEach(line => {
    try { callback(JSON.parse(line)); } catch {}
  });
}

self.onmessage = async (e) => {
  const { id, op, payload } = e.data || {};
  try {
    if (op === 'init') {
      await init();
      self.postMessage({ id, result: 'ready' });
    } else if (op === 'append') {
      const result = append(payload);
      // Notify the fold worker via the shared broadcast channel.
      try {
        const bc = new BroadcastChannel('eo-fold');
        bc.postMessage({ op: 'new_entry', entry: payload });
        bc.close();
      } catch {}
      self.postMessage({ id, result });
    } else if (op === 'query_anchor') {
      self.postMessage({ id, result: queryByAnchor(payload.anchor) });
    } else if (op === 'query_op') {
      self.postMessage({ id, result: queryByOp(payload.op) });
    } else if (op === 'scan_all') {
      const entries = [];
      scanAll(e2 => entries.push(e2));
      self.postMessage({ id, result: entries });
    } else if (op === 'flush_index') {
      const root = await navigator.storage.getDirectory();
      const corpus = await root.getDirectoryHandle('corpus');
      await flushIndex(corpus);
      self.postMessage({ id, result: 'flushed' });
    } else {
      self.postMessage({ id, error: 'unknown op: ' + op });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
