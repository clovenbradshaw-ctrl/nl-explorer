## Build Instructions: Primary Source Explorer

### What You're Starting With

The existing codebase has two panels in one HTML file: the ingest workspace (`EO//INGEST`) and the document explorer (`EO-DB`), connected by `syncExplorerFromIngest`. The ingest pipeline runs mechanically in the main thread. The explorer renders a pre-loaded static corpus. The bridge between them has field name mismatches that cause it to silently fail.

What follows is a phased build that preserves everything working, fixes what's broken, and extends toward the full architecture. Each phase is independently deployable.

---

### Phase 0: Fix the Bridge

Before building anything new, fix `syncExplorerFromIngest` so live ingest data actually flows into the explorer. Three specific fixes:

**Fix 1: Entity seeding uses wrong field names.**

Replace:
```javascript
if (e.op === 'SIG' && e.operand && (e.operand.kind === 'NP' || e.operand.type === 'entity')) {
  ensureEnt(e.anchor);
}
```

With:
```javascript
if (e.op === 'INS' && e.target === 'entity-registry') {
  ensureEnt(e.anchor);
}
```

**Fix 2: Span attachment uses impossible prefix check.**

Replace:
```javascript
if (e.target && typeof e.target === 'string' && e.target.startsWith('@e:')) {
  eid = entMap.get(e.target).id;
}
```

With:
```javascript
if (entMap.has(e.target)) {
  eid = entMap.get(e.target).id;
} else if (entMap.has(e.anchor)) {
  eid = entMap.get(e.anchor).id;
}
```

**Fix 3: CON edges read wrong field for object anchor.**

Replace:
```javascript
const t = entByAnchor.get(e.target)?.id;
```

With:
```javascript
const t = entByAnchor.get(e.operand?.object_anchor)?.id;
```

Verify by: ingest Sample A, flip to explorer, confirm entities appear from ingest rather than the pre-loaded Nashville corpus.

---

### Phase 1: OPFS Persistence Layer

**Create `workers/log-worker.js`** — this worker owns the G log exclusively. Nothing else touches the log file.

```javascript
// workers/log-worker.js
let fileHandle = null;
let accessHandle = null;
let index = {};          // anchor → [byte_offset, ...]
let opIndex = {};        // op → [byte_offset, ...]
let byteLength = 0;

async function init() {
  const root = await navigator.storage.getDirectory();
  const corpus = await root.getDirectoryHandle('corpus', { create: true });
  fileHandle = await corpus.getFileHandle('g_log.ndjson', { create: true });
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
  } catch { /* first run */ }
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

  // Update index
  const a = entry.anchor;
  if (!index[a]) index[a] = [];
  index[a].push(offset);

  const op = entry.op;
  if (!opIndex[op]) opIndex[op] = [];
  opIndex[op].push(offset);

  return { log_id: entry.log_id, offset };
}

function readAt(offset) {
  // Read forward from offset until newline
  const buf = new Uint8Array(8192);
  accessHandle.read(buf, { at: offset });
  const text = new TextDecoder().decode(buf);
  const line = text.split('\n')[0];
  return JSON.parse(line);
}

function queryByAnchor(anchor) {
  const offsets = index[anchor] || [];
  return offsets.map(o => readAt(o));
}

function queryByOp(op) {
  const offsets = opIndex[op] || [];
  return offsets.map(o => readAt(o));
}

function scanAll(callback) {
  const buf = new Uint8Array(byteLength);
  accessHandle.read(buf, { at: 0 });
  const text = new TextDecoder().decode(buf);
  const lines = text.split('\n').filter(l => l.trim());
  lines.forEach(line => {
    try { callback(JSON.parse(line)); } catch {}
  });
}

self.onmessage = async (e) => {
  const { id, op, payload } = e.data;
  if (op === 'init') {
    await init();
    self.postMessage({ id, result: 'ready' });
  } else if (op === 'append') {
    const result = append(payload);
    // Broadcast to fold worker
    const bc = new BroadcastChannel('eo-fold');
    bc.postMessage({ op: 'new_entry', entry: payload });
    bc.close();
    self.postMessage({ id, result });
  } else if (op === 'query_anchor') {
    self.postMessage({ id, result: queryByAnchor(payload.anchor) });
  } else if (op === 'query_op') {
    self.postMessage({ id, result: queryByOp(payload.op) });
  } else if (op === 'scan_all') {
    const entries = [];
    scanAll(e => entries.push(e));
    self.postMessage({ id, result: entries });
  } else if (op === 'flush_index') {
    const root = await navigator.storage.getDirectory();
    const corpus = await root.getDirectoryHandle('corpus');
    await flushIndex(corpus);
    self.postMessage({ id, result: 'flushed' });
  }
};
```

**Create `workers/fold-worker.js`** — maintains M state incrementally:

```javascript
// workers/fold-worker.js
// In-memory M state
const M = {
  entities: new Map(),     // anchor → entity record
  defFrames: new Map(),    // anchor → current DEF frame
  conEdges: new Map(),     // `${s}:${o}` → edge record
  evaHistory: new Map(),   // anchor → EVA_entry[]
  recPending: new Map(),   // anchor → REC candidate
  pressure: new Map(),     // anchor → {raw, z, reasons}
  spoIndex: new Map(),     // predicate_norm → [{s,p,o,cell_id,conf,span}]
  displayNames: new Map(), // anchor → string
};

let checkpointDirty = false;
let deltaBuffer = [];
const CHECKPOINT_INTERVAL = 50; // flush checkpoint every N deltas

const bc = new BroadcastChannel('eo-fold');
bc.onmessage = (e) => {
  if (e.data.op === 'new_entry') {
    fold(e.data.entry);
  }
};

async function init() {
  const root = await navigator.storage.getDirectory();
  const corpus = await root.getDirectoryHandle('corpus', { create: true });

  // Load checkpoint
  try {
    const cpHandle = await corpus.getFileHandle('m_checkpoint.json');
    const file = await cpHandle.getFile();
    const cp = JSON.parse(await file.text());
    restoreFromCheckpoint(cp);
  } catch { /* no checkpoint */ }

  // Replay delta
  try {
    const deltaHandle = await corpus.getFileHandle('m_delta.ndjson');
    const file = await deltaHandle.getFile();
    const lines = (await file.text()).split('\n').filter(l => l.trim());
    lines.forEach(line => {
      try { fold(JSON.parse(line), false); } catch {}
    });
  } catch { /* no delta */ }

  self.postMessage({ op: 'ready' });
}

function fold(entry, record = true) {
  if (record) deltaBuffer.push(entry);

  switch (entry.op) {
    case 'INS': foldINS(entry); break;
    case 'DEF': foldDEF(entry); break;
    case 'CON': foldCON(entry); break;
    case 'EVA': foldEVA(entry); break;
    case 'REC': foldREC(entry); break;
    case 'SIG': foldSIG(entry); break;
    case 'SYN': foldSYN(entry); break;
    case 'NUL': foldNUL(entry); break;
  }

  if (record && deltaBuffer.length >= CHECKPOINT_INTERVAL) {
    flushDelta();
  }

  // Broadcast M update to main thread
  self.postMessage({ op: 'm_update', anchor: entry.anchor, entry });
}

function foldINS(entry) {
  if (entry.target !== 'entity-registry') return;
  const a = entry.anchor;
  if (!M.entities.has(a)) {
    M.entities.set(a, {
      anchor: a,
      ops: ['INS'],
      sig_count: entry.provenance?.sig_count || 1,
      ts_ins: entry.ts,
      docs: new Set([entry.provenance?.doc_anchor]),
    });
  }
}

function foldDEF(entry) {
  const a = entry.target;
  if (entry.operand?.param === 'display_name') {
    M.displayNames.set(a, entry.operand.value);
  }
  if (entry.operand?.param === 'frame') {
    M.defFrames.set(a, {
      anchor: a,
      value: entry.operand.value,
      neighbor_set: entry.operand.neighbor_set || [],
      relation_types: entry.operand.relation_types || [],
      is_hub: entry.operand.is_hub || false,
      ts: entry.ts,
      doc_anchor: entry.operand.doc_anchor,
    });
  }
  const ent = M.entities.get(a);
  if (ent && !ent.ops.includes('DEF')) ent.ops.push('DEF');
}

function foldCON(entry) {
  const s = entry.target;
  const o = entry.operand?.object_anchor;
  if (!s || !o) return;
  const key = `${s}:${o}`;
  const existing = M.conEdges.get(key);
  if (existing) {
    existing.confidence = Math.min(0.99, existing.confidence + 0.05);
    existing.sources.push(entry.provenance?.doc_anchor);
    existing.count++;
  } else {
    M.conEdges.set(key, {
      s, o,
      predicate: entry.operand?.verb || entry.operand?.relation_type || 'related',
      confidence: entry.provenance?.confidence || 0.5,
      sources: [entry.provenance?.doc_anchor],
      count: 1,
      ts: entry.ts,
    });
  }
  const ent = M.entities.get(s);
  if (ent && !ent.ops.includes('CON')) ent.ops.push('CON');
}

function foldEVA(entry) {
  const a = entry.target;
  if (!M.evaHistory.has(a)) M.evaHistory.set(a, []);
  M.evaHistory.get(a).push({
    result: entry.operand?.result,
    eva_type: entry.operand?.eva_type,
    ts: entry.ts,
    anchor: entry.anchor,
  });
  updatePressure(a);
}

function foldREC(entry) {
  const a = entry.target;
  M.recPending.set(a, {
    trigger: entry.operand?.trigger,
    note: entry.operand?.note,
    frame_versions: entry.operand?.frame_versions,
    conflict_count: entry.operand?.conflict_count,
    ts: entry.ts,
    anchor: entry.anchor,
  });
}

function foldSIG(entry) {
  if (entry.operand?.detector === 'PRONOUN') {
    // Queue for coreference resolution
    self.postMessage({
      op: 'pronoun_pending',
      entry,
      grain: 'sentence', // default, resolved below
    });
  }
}

function foldSYN(entry) {
  // Hub topology — update entity hub status
  const hub = entry.operand?.hub_anchor;
  if (hub && M.entities.has(hub)) {
    M.entities.get(hub).is_hub = true;
    M.entities.get(hub).hub_degree = entry.operand?.hub_degree || 0;
  }
}

function foldNUL(entry) {
  // Record absence in entity docs set if target is an entity anchor
  const a = entry.target;
  if (M.entities.has(a)) {
    const ent = M.entities.get(a);
    if (!ent.nul_signals) ent.nul_signals = [];
    ent.nul_signals.push({
      signal: entry.operand?.signal,
      absence_type: entry.operand?.absence_type,
      ts: entry.ts,
    });
  }
}

function updatePressure(anchor) {
  // Recompute z-score across all entities when one changes
  // Throttled — only run if enough entities to normalize
  if (M.entities.size < 2) return;

  const rawScores = new Map();
  for (const [a, ent] of M.entities) {
    let raw = 0;
    const evas = M.evaHistory.get(a) || [];
    const conflicts = evas.filter(e => e.result === 'conflicts').length;
    raw += conflicts * 3;
    if ((ent.sig_count || 1) === 1) raw += 2;
    if (M.recPending.has(a)) raw += 5;
    const nuls = ent.nul_signals?.length || 0;
    raw += nuls * 0.8;
    rawScores.set(a, raw);
  }

  const vals = [...rawScores.values()];
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length) || 1;

  for (const [a, raw] of rawScores) {
    M.pressure.set(a, {
      raw,
      z: parseFloat(((raw-mean)/sd).toFixed(3)),
    });
  }
}

async function flushDelta() {
  if (!deltaBuffer.length) return;
  const root = await navigator.storage.getDirectory();
  const corpus = await root.getDirectoryHandle('corpus');
  const handle = await corpus.getFileHandle('m_delta.ndjson', { create: true });
  const existing = await (await handle.getFile()).text();
  const w = await handle.createWritable();
  await w.write(existing + deltaBuffer.map(e=>JSON.stringify(e)).join('\n') + '\n');
  await w.close();
  deltaBuffer = [];

  // Periodically write full checkpoint
  checkpointDirty = true;
  if (checkpointDirty) await writeCheckpoint(corpus);
}

async function writeCheckpoint(corpus) {
  const cp = {
    entities: Object.fromEntries(
      [...M.entities.entries()].map(([k,v]) => [k, {...v, docs: [...v.docs]}])
    ),
    defFrames: Object.fromEntries(M.defFrames),
    conEdges: Object.fromEntries(M.conEdges),
    evaHistory: Object.fromEntries(M.evaHistory),
    recPending: Object.fromEntries(M.recPending),
    pressure: Object.fromEntries(M.pressure),
    displayNames: Object.fromEntries(M.displayNames),
    ts: new Date().toISOString(),
  };
  const handle = await corpus.getFileHandle('m_checkpoint.json', { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(cp));
  await w.close();

  // Clear delta after checkpoint
  const deltaHandle = await corpus.getFileHandle('m_delta.ndjson', { create: true });
  const dw = await deltaHandle.createWritable();
  await dw.write('');
  await dw.close();
  checkpointDirty = false;
}

function restoreFromCheckpoint(cp) {
  for (const [k,v] of Object.entries(cp.entities||{}))
    M.entities.set(k, {...v, docs: new Set(v.docs)});
  for (const [k,v] of Object.entries(cp.defFrames||{})) M.defFrames.set(k,v);
  for (const [k,v] of Object.entries(cp.conEdges||{})) M.conEdges.set(k,v);
  for (const [k,v] of Object.entries(cp.evaHistory||{})) M.evaHistory.set(k,v);
  for (const [k,v] of Object.entries(cp.recPending||{})) M.recPending.set(k,v);
  for (const [k,v] of Object.entries(cp.pressure||{})) M.pressure.set(k,v);
  for (const [k,v] of Object.entries(cp.displayNames||{})) M.displayNames.set(k,v);
}

self.onmessage = async (e) => {
  const { id, op, payload } = e.data;
  if (op === 'init') { await init(); }
  else if (op === 'get_entity') {
    self.postMessage({ id, result: M.entities.get(payload.anchor) });
  }
  else if (op === 'get_frame') {
    self.postMessage({ id, result: M.defFrames.get(payload.anchor) });
  }
  else if (op === 'get_pressure') {
    self.postMessage({ id, result: Object.fromEntries(M.pressure) });
  }
  else if (op === 'get_graph') {
    self.postMessage({ id, result: {
      nodes: Object.fromEntries(M.entities),
      edges: Object.fromEntries(M.conEdges),
      displayNames: Object.fromEntries(M.displayNames),
    }});
  }
  else if (op === 'resolve_coreference') {
    self.postMessage({ id, result: resolveCoref(payload) });
  }
  else if (op === 'flush') {
    await flushDelta();
    self.postMessage({ id, result: 'flushed' });
  }
};
```

---

### Phase 2: Document Storage with Format Preservation

**Add to the ingest pipeline** — before any processing, write the raw document to OPFS. This replaces nothing in the current pipeline; it runs as a pre-step.

```javascript
async function storeRawDocument(text, title, docAnchor) {
  const root = await navigator.storage.getDirectory();
  const corpus = await root.getDirectoryHandle('corpus', { create: true });
  const docs = await corpus.getDirectoryHandle('documents', { create: true });

  // Raw text — never modified
  const rawHandle = await docs.getFileHandle(`${docAnchor}.raw`, { create: true });
  const w = await rawHandle.createWritable();
  await w.write(text);
  await w.close();

  // Format metadata — paragraph boundaries, headers, tables
  const meta = extractFormatMeta(text);
  const metaHandle = await docs.getFileHandle(`${docAnchor}.meta.json`, { create: true });
  const mw = await metaHandle.createWritable();
  await mw.write(JSON.stringify(meta));
  await mw.close();
}

function extractFormatMeta(text) {
  const paragraphs = [];
  const headers = [];
  let pos = 0;

  // Paragraph detection — double newline
  const paraRegex = /\n\s*\n/g;
  let lastEnd = 0;
  let m;
  while ((m = paraRegex.exec(text)) !== null) {
    const para = text.slice(lastEnd, m.index).trim();
    if (para.length > 0) {
      const start = text.indexOf(para, lastEnd);
      paragraphs.push({ start, end: start + para.length, text: para.slice(0, 80) });
    }
    lastEnd = m.index + m[0].length;
  }
  // Last paragraph
  const last = text.slice(lastEnd).trim();
  if (last.length > 0) {
    const start = text.indexOf(last, lastEnd);
    paragraphs.push({ start, end: start + last.length, text: last.slice(0, 80) });
  }

  // Header detection — ALL CAPS lines, or lines ending with colon followed by newline
  const lines = text.split('\n');
  let lineStart = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 3 && trimmed.length < 120) {
      if (/^[A-Z][A-Z\s\.\-\:]{4,}$/.test(trimmed) || /^#{1,6}\s/.test(trimmed)) {
        headers.push({ start: lineStart + (line.indexOf(trimmed)), text: trimmed });
      }
    }
    lineStart += line.length + 1;
  }

  return { paragraphs, headers };
}
```

**Store spans after ingest** — after the ingest pipeline runs and produces the log, write a resolved spans file per document:

```javascript
async function storeResolvedSpans(log, docAnchor) {
  const spans = log.entries()
    .filter(e => e.provenance?.span_start != null && e.provenance?.doc_anchor === docAnchor)
    .map(e => ({
      log_id: e.log_id,
      anchor: e.anchor,
      op: e.op,
      span_start: e.provenance.span_start,
      span_end: e.provenance.span_end,
      confidence: e.provenance.confidence,
      cell_id: e.operand?.cell_id,
      entity_anchor: e.target === 'entity-registry' ? e.anchor :
                     e.target?.startsWith('@') ? e.target : null,
      detector: e.operand?.detector,
    }));

  const root = await navigator.storage.getDirectory();
  const corpus = await root.getDirectoryHandle('corpus');
  const docs = await corpus.getDirectoryHandle('documents');
  const handle = await docs.getFileHandle(`${docAnchor}.spans.ndjson`, { create: true });
  const w = await handle.createWritable();
  await w.write(spans.map(s => JSON.stringify(s)).join('\n'));
  await w.close();
}
```

---

### Phase 3: Coreference Resolution via Integral-Fold

**Add to the fold worker** — the per-grain live entity queues. This runs inside `fold-worker.js` alongside the existing fold logic:

```javascript
// Grain queues — live entity pool with decay weights
const GRAIN = { CLAUSE: 0, SENTENCE: 1, PARAGRAPH: 2, DOCUMENT: 3 };
const DECAY = [1.0, 0.8, 0.4, 0.05]; // weight at each grain boundary

// Each queue entry: { anchor, weight, ts, position }
const grainQueues = [[], [], [], []];

function pushToQueues(anchor, position) {
  // Add to all queues at full weight
  for (let g = 0; g < 4; g++) {
    grainQueues[g].push({ anchor, weight: 1.0, position });
  }
}

function decayAtBoundary(grainLevel) {
  // Called when SEG fires at this grain level
  // Decay everything at finer grains
  for (let g = 0; g <= grainLevel; g++) {
    grainQueues[g] = grainQueues[g]
      .map(e => ({ ...e, weight: e.weight * DECAY[g] }))
      .filter(e => e.weight > 0.02); // remove below threshold
  }
}

// Add to foldINS:
function foldINS(entry) {
  if (entry.target !== 'entity-registry') return;
  const a = entry.anchor;
  // ... existing entity creation code ...
  // Push to all grain queues
  pushToQueues(a, entry.ts);
}

// Add to foldSEG:
function foldSEG(entry) {
  if (entry.operand?.type === 'clause') decayAtBoundary(GRAIN.CLAUSE);
  else if (entry.operand?.type === 'sentence') decayAtBoundary(GRAIN.SENTENCE);
  // paragraph boundaries implied by double-newline in meta
}

function resolveCoref(payload) {
  const { text, position, gram_features } = payload;
  // gram_features: { number: 'plural'|'singular', person: '1'|'2'|'3', animacy: 'animate'|'inanimate'|null }

  // Try each grain from finest to coarsest
  for (let g = GRAIN.CLAUSE; g <= GRAIN.DOCUMENT; g++) {
    const queue = grainQueues[g];
    if (!queue.length) continue;

    // Filter by grammatical compatibility
    const compatible = queue.filter(e => {
      const ent = M.entities.get(e.anchor);
      if (!ent) return false;
      // Number agreement check
      if (gram_features?.number === 'plural' && ent.number === 'singular') return false;
      if (gram_features?.number === 'singular' && ent.number === 'plural') return false;
      return true;
    });

    if (!compatible.length) continue;

    // Find peak — highest weight candidate
    const sorted = compatible.slice().sort((a,b) => b.weight - a.weight);
    const top = sorted[0];
    const second = sorted[1];
    const gap = second ? top.weight - second.weight : top.weight;
    const confidence = Math.min(0.95, gap * 2);

    return {
      resolved: true,
      anchor: top.anchor,
      grain: g,
      confidence,
      gap,
      alternatives: sorted.slice(1, 4).map(e => ({
        anchor: e.anchor,
        weight: e.weight,
      })),
      nul_state: null,
    };
  }

  // No resolution found — determine NUL state
  // Check if any compatible anchor ever existed
  const everExisted = [...M.entities.values()].some(e => {
    if (gram_features?.number === 'plural' && e.number === 'singular') return false;
    return true;
  });

  let nul_state;
  if (everExisted) {
    nul_state = 'cleared'; // existed but decayed out of scope
  } else {
    nul_state = 'unknown'; // slot exists but was never filled
  }

  return {
    resolved: false,
    anchor: null,
    grain: null,
    confidence: 0,
    nul_state,
  };
}
```

**In the main ingest pipeline**, replace the current shallow pronoun stage with one that posts to the fold worker:

```javascript
async function stageSIG_pronouns_withCoref(log, text, da) {
  const pat = PRONOUN_PATTERNS[_currentScript] || PRONOUN_PATTERNS.latin;
  const re = new RegExp(pat.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const pronoun = m[0];

    // Basic grammatical feature detection
    const gram = detectGramFeatures(pronoun);

    // Post to fold worker for integral-fold resolution
    const resolution = await foldWorkerRequest('resolve_coreference', {
      text: pronoun,
      position: m.index,
      gram_features: gram,
    });

    const a = anchor('pron:' + pronoun.toLowerCase() + ':' + m.index);

    if (resolution.resolved) {
      // Emit CON connecting pronoun SIG to resolved INS anchor
      log.push(makeEntry('CON', anchor('coref:' + a + ':' + resolution.anchor), a, {
        object_anchor: resolution.anchor,
        relation_type: 'coreference',
        pronoun_text: pronoun,
        resolution_grain: resolution.grain,
        alternatives: resolution.alternatives,
      }, {
        source: 'mechanical:coref_integral_fold',
        span_start: m.index,
        span_end: m.index + pronoun.length,
        doc_anchor: da,
        confidence: resolution.confidence,
      }));
    } else {
      // Emit SIG with NUL state
      log.push(makeEntry('SIG', a, `doc:${da}`, {
        text: pronoun,
        detector: 'PRONOUN',
        resolution_status: 'unresolved',
        nul_state: resolution.nul_state,
        candidate_op: 'CON',
      }, {
        source: 'mechanical:pronoun',
        span_start: m.index,
        span_end: m.index + pronoun.length,
        doc_anchor: da,
        confidence: 0.0,
      }));

      // Emit corresponding NUL entry
      log.push(makeEntry('NUL', anchor('nul:coref:' + a), `doc:${da}`, {
        absence_type: resolution.nul_state,
        signal: pronoun,
        expected: 'coreference_anchor',
      }, {
        source: 'mechanical:coref_nul',
        span_start: m.index,
        span_end: m.index + pronoun.length,
        doc_anchor: da,
        confidence: 0.85,
      }));
    }
  }
}

function detectGramFeatures(pronoun) {
  const p = pronoun.toLowerCase();
  const plural = ['they','them','their','theirs','we','us','our','ours'];
  const singular = ['he','him','his','she','her','hers','it','its','i','me','my'];
  return {
    number: plural.includes(p) ? 'plural' : singular.includes(p) ? 'singular' : null,
    person: ['i','me','my','we','us','our'].includes(p) ? 'first' :
            ['you','your','yours'].includes(p) ? 'second' : 'third',
    animacy: ['it','its'].includes(p) ? 'inanimate' : null,
  };
}
```

---

### Phase 4: SPO Extraction Upgrade

Replace the existing `stageCON_cooccurrence` with a three-tier extractor. Keep the co-occurrence logic as the fallback but add a structured constituency pass for simple sentences and an LLM escalation queue for complex ones.

```javascript
function extractSPO_heuristic(sentence) {
  // Tier 1: Simple SVO — subject before verb before object
  // Handles: "[NP] [VP] [NP]" patterns in declarative sentences
  const triples = [];
  const tokens = tokenize(sentence);

  let subjectToks = [];
  let verbTok = null;
  let objectToks = [];
  let state = 'seeking_subject';

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const tag = tagToken(tok.clean, i > 0 ? tokens[i-1].clean : '', i === 0);

    if (state === 'seeking_subject') {
      if (tag === 'PROPER' || tag === 'NOUN') {
        subjectToks.push(tok);
      } else if (tag === 'VERB' && subjectToks.length > 0) {
        verbTok = tok;
        state = 'seeking_object';
      }
    } else if (state === 'seeking_object') {
      if (tag === 'PROPER' || tag === 'NOUN') {
        objectToks.push(tok);
      } else if ((tag === 'VERB' || tag === 'STOP') && objectToks.length > 0) {
        // Flush triple
        const s = subjectToks.map(t=>t.clean).join(' ');
        const p = verbTok.clean;
        const o = objectToks.map(t=>t.clean).join(' ');
        triples.push({ s, p, o,
          s_start: subjectToks[0].start,
          p_start: verbTok.start,
          o_start: objectToks[0].start,
          o_end: objectToks[objectToks.length-1].end,
          confidence: 0.65,
        });
        // Reset for next triple in sentence
        subjectToks = []; verbTok = null; objectToks = [];
        state = 'seeking_subject';
        i--; // reprocess this token as potential new subject
      }
    }
  }

  // Flush final triple
  if (subjectToks.length && verbTok && objectToks.length) {
    triples.push({
      s: subjectToks.map(t=>t.clean).join(' '),
      p: verbTok.clean,
      o: objectToks.map(t=>t.clean).join(' '),
      s_start: subjectToks[0].start,
      p_start: verbTok.start,
      o_start: objectToks[0].start,
      o_end: objectToks[objectToks.length-1].end,
      confidence: 0.65,
    });
  }

  return triples;
}

function stageSPO(log, sentences, entityAnchors, da) {
  const llmQueue = []; // complex sentences queued for LLM pass

  for (const sent of sentences) {
    const triples = extractSPO_heuristic(sent.text);

    for (const triple of triples) {
      // Resolve surface forms to entity anchors
      const sNorm = normalizeNP(triple.s);
      const oNorm = normalizeNP(triple.o);
      const sAnchor = entityAnchors[sNorm] || findNearestAnchor(sNorm, entityAnchors);
      const oAnchor = entityAnchors[oNorm] || findNearestAnchor(oNorm, entityAnchors);

      if (!sAnchor || !oAnchor) {
        // Can't ground both ends — queue for LLM
        if (triple.confidence < 0.5) {
          llmQueue.push({ sent: sent.text, triple, sent_start: sent.start });
        }
        continue;
      }

      const predNorm = triple.p.toLowerCase();
      const conAnchor = anchor(`spo:${sAnchor}:${predNorm}:${oAnchor}:${sent.start}`);

      log.push(makeEntry('CON', conAnchor, sAnchor, {
        object_anchor: oAnchor,
        predicate: triple.p,
        predicate_normalized: predNorm,
        relation_type: 'spo',
        subject_text: triple.s,
        object_text: triple.o,
        sentence_fragment: sent.text.slice(0, 120),
        spo: { s: triple.s, p: triple.p, o: triple.o },
      }, {
        source: 'mechanical:spo_heuristic',
        span_start: sent.start + triple.s_start,
        span_end: sent.start + triple.o_end,
        doc_anchor: da,
        confidence: triple.confidence,
      }));
    }

    // Flag complex sentences for LLM pass
    if (triples.length === 0 && sent.text.length > 40) {
      llmQueue.push({ sent: sent.text, triple: null, sent_start: sent.start });
    }
  }

  return llmQueue; // caller decides whether to run LLM pass
}

function findNearestAnchor(norm, entityAnchors) {
  // Substring match fallback
  for (const [key, anc] of Object.entries(entityAnchors)) {
    if (key.includes(norm) || norm.includes(key)) return anc;
  }
  return null;
}
```

**LLM pass** — runs on-demand when user clicks a span or in background for flagged sentences:

```javascript
async function stageSPO_llm(sentences, entityAnchors, da, log) {
  const batch = sentences.slice(0, 20); // cap batch size
  if (!batch.length) return;

  const prompt = `Extract all Subject-Predicate-Object triples from each sentence.
Return JSON array: [{"s":"subject","p":"predicate","o":"object","sentence_index":N}]
Only extract triples where both subject and object are named entities.
Return only JSON, no other text.

Sentences:
${batch.map((item, i) => `${i}: ${item.sent}`).join('\n')}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data.content[0]?.text || '[]';
    const triples = JSON.parse(text.replace(/```json|```/g, '').trim());

    for (const t of triples) {
      const item = batch[t.sentence_index];
      if (!item) continue;

      const sNorm = normalizeNP(t.s);
      const oNorm = normalizeNP(t.o);
      const sAnchor = entityAnchors[sNorm] || findNearestAnchor(sNorm, entityAnchors);
      const oAnchor = entityAnchors[oNorm] || findNearestAnchor(oNorm, entityAnchors);
      if (!sAnchor || !oAnchor) continue;

      const predNorm = t.p.toLowerCase();
      log.push(makeEntry('CON', anchor(`llm_spo:${sAnchor}:${predNorm}:${oAnchor}`), sAnchor, {
        object_anchor: oAnchor,
        predicate: t.p,
        predicate_normalized: predNorm,
        relation_type: 'spo_llm',
        spo: { s: t.s, p: t.p, o: t.o },
        sentence_fragment: item.sent.slice(0, 120),
      }, {
        source: 'llm:spo_extraction',
        doc_anchor: da,
        confidence: 0.85,
      }));
    }
  } catch (e) {
    console.warn('LLM SPO pass failed:', e);
  }
}
```

---

### Phase 5: The Text Rendering Layer

This replaces the current `renderDocViewer` and `annotateText` functions with a multi-grain aware renderer that reads from OPFS.

```javascript
async function renderDocumentFromOPFS(docAnchor, grain = 'sentence', activeSpanId = null) {
  const root = await navigator.storage.getDirectory();
  const corpus = await root.getDirectoryHandle('corpus');
  const docs = await corpus.getDirectoryHandle('documents');

  // Load raw text
  const rawHandle = await docs.getFileHandle(`${docAnchor}.raw`);
  const rawText = await (await rawHandle.getFile()).text();

  // Load format meta
  const metaHandle = await docs.getFileHandle(`${docAnchor}.meta.json`);
  const meta = JSON.parse(await (await metaHandle.getFile()).text());

  // Load spans
  const spansHandle = await docs.getFileHandle(`${docAnchor}.spans.ndjson`);
  const spansText = await (await spansHandle.getFile()).text();
  const spans = spansText.split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l))
    .filter(s => grainFilter(s, grain))
    .sort((a,b) => a.span_start - b.span_start);

  return buildAnnotatedHTML(rawText, meta, spans, activeSpanId, grain);
}

function grainFilter(span, grain) {
  // At clause grain: show all operators
  // At sentence grain: suppress clause-only events
  // At paragraph grain: show only entity-level events
  if (grain === 'clause') return true;
  if (grain === 'sentence') {
    return ['INS','CON','SYN','DEF','EVA','NUL','REC'].includes(span.op);
  }
  if (grain === 'paragraph') {
    return ['INS','SYN','DEF','REC'].includes(span.op);
  }
  return true;
}

function buildAnnotatedHTML(rawText, meta, spans, activeSpanId, grain) {
  // Walk raw text, insert annotation wrappers at span boundaries
  // Handle nesting: sentence spans contain clause spans
  let html = '';
  let pos = 0;

  // Build sorted span list with nesting depth
  const annotated = buildNestingOrder(spans);

  for (const event of annotated) {
    if (event.type === 'text') {
      html += escapeHtml(rawText.slice(pos, event.end));
      pos = event.end;
    } else if (event.type === 'open') {
      if (event.span.span_start > pos) {
        html += escapeHtml(rawText.slice(pos, event.span.span_start));
        pos = event.span.span_start;
      }
      const op = event.span.op.toLowerCase();
      const conf = event.span.confidence || 0.5;
      const opacity = Math.max(0.15, conf * 0.6);
      const isActive = event.span.log_id === activeSpanId;
      html += `<span class="anno anno-${op} ${isActive ? 'anno-active' : ''}"
        style="background:${opColor(event.span.op, opacity)}"
        data-log-id="${event.span.log_id}"
        data-anchor="${event.span.entity_anchor || event.span.anchor}"
        data-op="${event.span.op}"
        data-confidence="${conf.toFixed(2)}"
        onmouseenter="annoHover(this)"
        onmouseleave="annoLeave(this)"
        onclick="annoClick(this)">`;
    } else if (event.type === 'close') {
      html += '</span>';
      pos = event.span.span_end;
    }
  }

  if (pos < rawText.length) {
    html += escapeHtml(rawText.slice(pos));
  }

  return html;
}

function opColor(op, opacity) {
  const colors = {
    INS: `rgba(78,143,98,${opacity})`,
    SIG: `rgba(251,191,36,${opacity})`,
    CON: `rgba(184,118,50,${opacity})`,
    SEG: `rgba(96,165,250,${opacity})`,
    SYN: `rgba(138,106,154,${opacity})`,
    DEF: `rgba(34,211,238,${opacity})`,
    EVA: `rgba(167,139,250,${opacity})`,
    NUL: `rgba(248,113,113,${opacity})`,
    REC: `rgba(244,114,182,${opacity})`,
  };
  return colors[op] || `rgba(128,128,128,${opacity})`;
}

function buildNestingOrder(spans) {
  // Convert flat span list to open/close events in correct nesting order
  const events = [];
  const stack = [];

  const sorted = spans.slice().sort((a,b) =>
    a.span_start - b.span_start ||
    (b.span_end - b.span_start) - (a.span_end - a.span_start) // wider spans open first
  );

  for (const span of sorted) {
    // Close any spans that ended before this one starts
    while (stack.length && stack[stack.length-1].span_end <= span.span_start) {
      events.push({ type: 'close', span: stack.pop() });
    }
    events.push({ type: 'open', span });
    stack.push(span);
  }

  while (stack.length) {
    events.push({ type: 'close', span: stack.pop() });
  }

  return events;
}
```

---

### Phase 6: Continuous DEF→EVA→REC Loop

In the fold worker, add a dirty-flag queue that processes entities in batches so EVA doesn't block:

```javascript
// In fold-worker.js
const dirtyQueue = new Set();
let evaLoopRunning = false;

function markDirty(anchor) {
  dirtyQueue.add(anchor);
  if (!evaLoopRunning) scheduleEVABatch();
}

function scheduleEVABatch() {
  evaLoopRunning = true;
  setTimeout(processEVABatch, 50); // yield, then process
}

function processEVABatch() {
  const batch = [...dirtyQueue].slice(0, 10); // process 10 per tick
  batch.forEach(a => {
    dirtyQueue.delete(a);
    runEVAForEntity(a);
  });

  if (dirtyQueue.size > 0) {
    setTimeout(processEVABatch, 16); // next frame
  } else {
    evaLoopRunning = false;
    // Broadcast updated pressure map
    const pressure = Object.fromEntries(M.pressure);
    self.postMessage({ op: 'pressure_update', pressure });
  }
}

function runEVAForEntity(anchor) {
  const frame = M.defFrames.get(anchor);
  if (!frame) return;

  const edges = [...M.conEdges.entries()]
    .filter(([k]) => k.startsWith(anchor + ':') || k.endsWith(':' + anchor));

  const currentNeighbors = new Set(edges.map(([k]) => {
    const parts = k.split(':');
    return parts[0] === anchor ? parts[1] : parts[0];
  }));

  const frameNeighbors = new Set(frame.neighbor_set || []);

  const lost = [...frameNeighbors].filter(n => !currentNeighbors.has(n));
  const gained = [...currentNeighbors].filter(n => !frameNeighbors.has(n));

  let result;
  if (lost.length === 0 && gained.length === 0) result = 'satisfies';
  else if (lost.length === 0) result = 'extends';
  else if (gained.length === 0) result = 'contracts';
  else result = 'conflicts';

  if (result !== 'satisfies') {
    const evaEntry = makeEntry('EVA',
      anchor(`eva:loop:${anchor}:${Date.now()}`),
      anchor, {
        eva_type: 'structural',
        result,
        neighbors_lost: lost,
        neighbors_gained: gained,
        neighbor_delta: gained.length - lost.length,
      }, {
        source: 'mechanical:eva_loop',
        confidence: result === 'extends' ? 0.85 : result === 'contracts' ? 0.7 : 0.9,
      });

    fold(evaEntry);

    // Check if REC threshold crossed
    const history = M.evaHistory.get(anchor) || [];
    const recentConflicts = history.filter(e =>
      e.result === 'conflicts' &&
      new Date(e.ts) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    ).length;

    if (recentConflicts >= 3 && frame.is_hub && !M.recPending.has(anchor)) {
      const recEntry = makeEntry('REC',
        anchor(`rec:loop:${anchor}`),
        anchor, {
          trigger: 'accumulated_eva_conflicts',
          conflict_count: recentConflicts,
          note: 'Frame under sustained pressure — requires human review',
          resolution: 'pending_human',
          frame_anchors: [frame.anchor],
        }, {
          source: 'mechanical:rec_threshold',
          confidence: Math.min(0.7 + recentConflicts * 0.05, 0.92),
        });

      fold(recEntry);
      // Surface to main thread
      self.postMessage({ op: 'rec_candidate', anchor, rec: recEntry });
    }
  }

  updatePressure(anchor);
}

// Trigger EVA when new CON edges arrive
function foldCON(entry) {
  // ... existing code ...
  markDirty(entry.target);
  if (entry.operand?.object_anchor) markDirty(entry.operand.object_anchor);
}
```

---

### Phase 7: Main Thread Worker Bridge

Replace the current direct function calls in `runIngest` with worker-routed calls. Add a worker manager module:

```javascript
// workers/worker-manager.js (loaded in main thread)
let logWorker, foldWorker;
let pendingRequests = new Map();
let reqId = 0;

function workerRequest(worker, op, payload) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pendingRequests.set(id, resolve);
    worker.postMessage({ id, op, payload });
  });
}

async function initWorkers() {
  logWorker = new Worker('workers/log-worker.js');
  foldWorker = new Worker('workers/fold-worker.js');

  [logWorker, foldWorker].forEach(w => {
    w.onmessage = (e) => {
      const { id, op, result } = e.data;
      if (id && pendingRequests.has(id)) {
        pendingRequests.get(id)(result);
        pendingRequests.delete(id);
      }
      // Handle broadcast ops from fold worker
      if (op === 'pressure_update') {
        renderPressureMapFromData(e.data.pressure);
      }
      if (op === 'rec_candidate') {
        surfaceRECCandidate(e.data.anchor, e.data.rec);
      }
      if (op === 'm_update') {
        handleMUpdate(e.data.anchor, e.data.entry);
      }
    };
  });

  await workerRequest(logWorker, 'init', {});
  await workerRequest(foldWorker, 'init', {});
}

// Replace makeEntry + direct log.push with:
async function appendToLog(entry) {
  return workerRequest(logWorker, 'append', entry);
}

async function queryEntityFromM(anchor) {
  return workerRequest(foldWorker, 'get_entity', { anchor });
}

async function getPressureMap() {
  return workerRequest(foldWorker, 'get_pressure', {});
}

async function getGraph() {
  return workerRequest(foldWorker, 'get_graph', {});
}
```

---

### Phase 8: Integration Into Existing runIngest

Modify `runIngest` to use OPFS storage and workers. The pipeline stages themselves don't change — only where their output goes:

```javascript
async function runIngest() {
  const text = document.getElementById('doc-input').value.trim();
  if (!text) return;
  const title = document.getElementById('doc-title-input').value.trim() || 'Document';

  document.getElementById('btn-process').disabled = true;

  // Pre-step: store raw document before any processing
  const docAnchor = anchor(text);
  await storeRawDocument(text, title, docAnchor);

  // Run existing ingest pipeline (unchanged)
  const { log, doc_anchor } = await ingest(text, title, title);

  // Route all log entries through Log Worker instead of in-memory state
  for (const entry of log.entries()) {
    await appendToLog(entry);
  }

  // Store resolved spans per document
  await storeResolvedSpans(log, doc_anchor);

  // The fold worker has already received all entries via BroadcastChannel
  // M state is being built incrementally in the fold worker
  // Wait for fold worker to signal completion
  await workerRequest(foldWorker, 'flush', {});

  // Update UI from worker state rather than in-memory state
  state.docs.push({ title, text, log, doc_anchor });
  state.activeDoc = state.docs.length - 1;

  // Cross-doc stages still run in main thread for now
  // (these will move to fold worker in a future phase)
  stageEVA_structural(state.combined, state.docs.map(d => d.log));
  if (state.docs.length > 1) {
    stageDEF_crossdoc(state.combined, state.docs.map(d => d.log));
  }

  renderAll();
  document.getElementById('btn-process').disabled = false;

  // Render text from OPFS rather than in-memory state
  const html = await renderDocumentFromOPFS(doc_anchor, currentGrain);
  document.getElementById('doc-viewer').innerHTML = html;
  document.getElementById('doc-input').style.display = 'none';
  document.getElementById('doc-viewer').style.display = 'block';
}
```

---

### What's Buildable Now vs What Needs More Work

**Build now without uncertainty:**
Phase 0 (bridge fix), Phase 1 (OPFS log + fold workers), Phase 2 (document storage), Phase 5 heuristic SPO tier, Phase 7 (main thread bridge), Phase 8 (runIngest integration). These are all mechanical extensions of existing patterns.

**Build now with known rough edges:**
Phase 3 (coreference) — the integral-fold architecture is correct but the grammatical feature detection is shallow. It will miss complex agreement patterns and fail on pro-drop languages. Works for English journalism text.

Phase 4 (rendering) — the nesting order algorithm handles most cases but will misrender spans that overlap without proper containment. Legal documents sometimes have this. Flag and skip rather than crash.

Phase 6 (continuous EVA loop) — the dirty-flag batch processor works but the REC threshold of three conflicts in seven days is a guess. Needs calibration against a real corpus before it surfaces meaningful signals rather than noise.

**Genuinely unknown until tested:**
Whether the 27-cell cell assignments at the predicate level produce stable enough clusters to be useful as operator classifiers. Whether EVA loop frequency creates perceptible lag at corpus sizes above 50 documents. Whether the OPFS sync access handle stays stable across long sessions without needing periodic close-and-reopen. Whether PDF span offsets from PDF.js align well enough with the raw text character positions to make span rendering accurate on PDF-sourced documents.

**Needs design decision before building:**
The cloud sync merge-ordering problem. The LLM SPO pass rate-limiting strategy. How to handle the transition from the current in-memory `state` object to the worker-backed persistent state without breaking the existing UI during the transition period.
