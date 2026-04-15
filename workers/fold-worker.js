// workers/fold-worker.js
// Maintains the mutable M state (entities, frames, edges, pressure) by
// folding log entries that arrive via the `eo-fold` BroadcastChannel.
// Also hosts the integral-fold coreference resolver and the continuous
// DEF → EVA → REC loop that surfaces frames under sustained pressure.

const M = {
  entities:    new Map(), // anchor → entity record
  defFrames:   new Map(), // anchor → current DEF frame
  conEdges:    new Map(), // `${s}:${o}` → edge record
  evaHistory:  new Map(), // anchor → EVA entry[]
  recPending:  new Map(), // anchor → REC candidate
  pressure:    new Map(), // anchor → {raw, z}
  spoIndex:    new Map(), // predicate_norm → [{s,p,o,cell_id,conf,span}]
  displayNames:new Map(), // anchor → string
};

let checkpointDirty = false;
let deltaBuffer = [];
const CHECKPOINT_INTERVAL = 50;

const bc = new BroadcastChannel('eo-fold');
bc.onmessage = (e) => {
  if (e.data?.op === 'new_entry') fold(e.data.entry);
};

async function init() {
  try {
    const root = await navigator.storage.getDirectory();
    const corpus = await root.getDirectoryHandle('corpus', { create: true });

    try {
      const cpHandle = await corpus.getFileHandle('m_checkpoint.json');
      const file = await cpHandle.getFile();
      const cp = JSON.parse(await file.text());
      restoreFromCheckpoint(cp);
    } catch { /* no checkpoint yet */ }

    try {
      const deltaHandle = await corpus.getFileHandle('m_delta.ndjson');
      const file = await deltaHandle.getFile();
      const lines = (await file.text()).split('\n').filter(l => l.trim());
      lines.forEach(line => {
        try { fold(JSON.parse(line), false); } catch {}
      });
    } catch { /* no delta yet */ }
  } catch (err) {
    // OPFS may be unavailable — worker can still operate in-memory.
    self.postMessage({ op: 'init_error', error: err?.message || String(err) });
  }
  self.postMessage({ op: 'ready' });
}

// ── Fold dispatchers ──────────────────────────────────────────

function fold(entry, record = true) {
  if (!entry || !entry.op) return;
  if (record) deltaBuffer.push(entry);

  switch (entry.op) {
    case 'INS': foldINS(entry); break;
    case 'DEF': foldDEF(entry); break;
    case 'CON': foldCON(entry); break;
    case 'EVA': foldEVA(entry); break;
    case 'REC': foldREC(entry); break;
    case 'SIG': foldSIG(entry); break;
    case 'SYN': foldSYN(entry); break;
    case 'SEG': foldSEG(entry); break;
    case 'NUL': foldNUL(entry); break;
  }

  if (record && deltaBuffer.length >= CHECKPOINT_INTERVAL) {
    flushDelta();
  }

  self.postMessage({ op: 'm_update', anchor: entry.anchor, entry });
}

function foldINS(entry) {
  if (entry.target !== 'entity-registry') return;
  const a = entry.anchor;
  const sig_count = entry.provenance?.sig_count || 1;
  if (!M.entities.has(a)) {
    M.entities.set(a, {
      anchor: a,
      ops: ['INS'],
      sig_count,
      ts_ins: entry.ts,
      docs: new Set([entry.provenance?.doc_anchor]),
      // ── Integral state ───────────────────────────────────────
      // I_e(p) at document position p — accumulated, decayed evidence.
      integral_value: Math.max(1, sig_count),
      // Per-grain integral snapshots (clause, sentence, paragraph, doc).
      grain_values: [1, 1, 1, 1].map(() => Math.max(1, sig_count)),
      // Running mean/variance of sig-event "strength" — coherence signal.
      // Low variance = tight integral; a jump raises bifurcation warning.
      coh_mean: 1,
      coh_m2: 0,                // Welford's running M2
      coh_n: sig_count,
      coherence_score: 1.0,     // 1 / (1 + var)
      last_mention_position: entry.ts,
      ins_coherence: 1.0,       // diagnostic: coherence at instantiation
    });
  } else {
    const ent = M.entities.get(a);
    ent.docs.add(entry.provenance?.doc_anchor);
    ent.last_mention_position = entry.ts;
  }
  pushToQueues(a, entry.ts);
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

  markDirty(s);
  markDirty(o);
}

function foldEVA(entry) {
  const a = entry.target;
  if (!a) return;
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
  if (!a) return;
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
    self.postMessage({ op: 'pronoun_pending', entry });
    return;
  }
  // NP / ACCUMULATION SIG events are differential elements dI for a candidate
  // entity. Route them to an instantiated entity if one exists at the same
  // canonical anchor; otherwise accumulate into a pre-INS candidate so we can
  // distinguish "unknown" (evidence but no INS) from "never-set" in NUL.
  const det = entry.operand?.detector;
  if (det !== 'NP' && det !== 'ACCUMULATION') return;
  const target = entry.target && entry.target.startsWith('@')
    ? entry.target
    : (entry.operand?.normalized ? anchorLocal('np:' + entry.operand.normalized) : null);
  if (!target) return;

  const strength = Math.max(0.1, entry.provenance?.confidence || 0.5);
  const ent = M.entities.get(target);
  if (ent) {
    // Fold: I_e += σ, update per-grain integral, update coherence variance.
    ent.integral_value = (ent.integral_value || 0) + strength;
    if (ent.grain_values) {
      for (let g = 0; g < ent.grain_values.length; g++) {
        ent.grain_values[g] += strength;
      }
    }
    // Welford online variance of sig strengths.
    ent.coh_n = (ent.coh_n || 0) + 1;
    const delta = strength - (ent.coh_mean || 0);
    ent.coh_mean = (ent.coh_mean || 0) + delta / ent.coh_n;
    ent.coh_m2 = (ent.coh_m2 || 0) + delta * (strength - ent.coh_mean);
    const variance = ent.coh_n > 1 ? ent.coh_m2 / (ent.coh_n - 1) : 0;
    const prev = ent.coherence_score ?? 1.0;
    ent.coherence_score = 1 / (1 + variance);
    ent.last_mention_position = entry.ts;
    // Bifurcation warning: sharp coherence drop on a hub-like entity.
    if (prev - ent.coherence_score > 0.25 && ent.sig_count > 3) {
      ent.bifurcation_flag = true;
      self.postMessage({
        op: 'bifurcation_warning',
        anchor: target,
        prev_coherence: prev,
        coherence: ent.coherence_score,
      });
    }
  } else {
    // Pre-INS candidate integral — tracked so the "unknown" NUL state
    // (evidence exists but no threshold crossing) is distinguishable from
    // "never-set" (no evidence at all) and "cleared" (post-INS decay).
    if (!M.candidates) M.candidates = new Map();
    const c = M.candidates.get(target) || {
      anchor: target, integral_value: 0, sig_count: 0,
      first_seen: entry.ts, normalized: entry.operand?.normalized,
    };
    c.integral_value += strength;
    c.sig_count += 1;
    c.last_seen = entry.ts;
    M.candidates.set(target, c);
  }
}

function foldSYN(entry) {
  const hub = entry.operand?.hub_anchor;
  if (hub && M.entities.has(hub)) {
    M.entities.get(hub).is_hub = true;
    M.entities.get(hub).hub_degree = entry.operand?.hub_degree || 0;
  }
}

function foldSEG(entry) {
  if (entry.operand?.type === 'clause') decayAtBoundary(GRAIN.CLAUSE);
  else if (entry.operand?.type === 'sentence') decayAtBoundary(GRAIN.SENTENCE);
  else if (entry.operand?.type === 'paragraph') decayAtBoundary(GRAIN.PARAGRAPH);
}

function foldNUL(entry) {
  const a = entry.target;
  if (M.entities.has(a)) {
    const ent = M.entities.get(a);
    if (!ent.nul_signals) ent.nul_signals = [];
    ent.nul_signals.push({
      signal: entry.operand?.signal,
      absence_type: entry.operand?.absence_type,
      ts: entry.ts,
    });
    updatePressure(a);
  }
}

// ── Pressure map ──────────────────────────────────────────────

function updatePressure(anchorId) {
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
  const mean = vals.reduce((x,y)=>x+y,0) / vals.length;
  const sd = Math.sqrt(vals.reduce((x,y)=>x+(y-mean)**2,0)/vals.length) || 1;
  for (const [a, raw] of rawScores) {
    M.pressure.set(a, { raw, z: parseFloat(((raw-mean)/sd).toFixed(3)) });
  }
}

// ── Integral-fold coreference queues ──────────────────────────

const GRAIN = { CLAUSE: 0, SENTENCE: 1, PARAGRAPH: 2, DOCUMENT: 3 };
const DECAY = [1.0, 0.8, 0.4, 0.05];
const grainQueues = [[], [], [], []];

function pushToQueues(anchorId, position) {
  for (let g = 0; g < 4; g++) {
    grainQueues[g].push({ anchor: anchorId, weight: 1.0, position });
  }
}

function decayAtBoundary(grainLevel) {
  // Decay grain-queue weights.
  for (let g = 0; g <= grainLevel; g++) {
    grainQueues[g] = grainQueues[g]
      .map(e => ({ ...e, weight: e.weight * DECAY[g] }))
      .filter(e => e.weight > 0.02);
  }
  // Decay per-entity grain integrals up to and including this grain.
  // Paragraph SEG → higher λ_e; document SEG → near-zero except prominent.
  for (const ent of M.entities.values()) {
    if (!ent.grain_values) continue;
    for (let g = 0; g <= grainLevel; g++) {
      ent.grain_values[g] *= DECAY[g];
    }
    // Top-level integral tracks the coarsest active grain.
    ent.integral_value = ent.grain_values[grainLevel];
    // Mark cleared if we've decayed below working-set after INS.
    if (ent.integral_value < 0.05 && ent.ops?.includes('INS')) {
      ent.cleared = true;
    }
  }
  // Decay pre-INS candidates too — evidence that never crossed threshold
  // fades and eventually drops out of the working set.
  if (M.candidates) {
    for (const [k, c] of M.candidates) {
      c.integral_value *= DECAY[grainLevel];
      if (c.integral_value < 0.05) M.candidates.delete(k);
    }
  }
}

function resolveCoref(payload) {
  const { gram_features } = payload || {};
  // Walk grains from narrowest to widest. At each grain, score candidates by
  // score = I_e,g(p) × compat(grammar) — the integral-times-compatibility
  // rule. Take the argmax whose score clears a working-set threshold.
  const WORKING_SET = 0.15;
  for (let g = GRAIN.CLAUSE; g <= GRAIN.DOCUMENT; g++) {
    const queue = grainQueues[g];
    if (!queue.length) continue;
    const scored = [];
    for (const e of queue) {
      const ent = M.entities.get(e.anchor);
      if (!ent) continue;
      if (gram_features?.number === 'plural' && ent.number === 'singular') continue;
      if (gram_features?.number === 'singular' && ent.number === 'plural') continue;
      const compat = 1.0; // no mention embedding available at this boundary
      const integ = (ent.grain_values?.[g] ?? ent.integral_value ?? e.weight);
      const score = integ * compat * e.weight;
      if (score < WORKING_SET) continue;
      scored.push({ anchor: e.anchor, score, integ, weight: e.weight });
    }
    if (!scored.length) continue;
    scored.sort((a,b) => b.score - a.score);
    const top = scored[0];
    const second = scored[1];
    const gap = second ? (top.score - second.score) / Math.max(top.score, 1e-6) : 1;
    const confidence = Math.min(0.95, gap);
    return {
      resolved: true,
      anchor: top.anchor,
      grain: g,
      confidence,
      gap,
      integral: top.integ,
      alternatives: scored.slice(1, 4),
      nul_state: null,
    };
  }

  // No resolution. Distinguish the three NUL states the spec requires:
  //  · never_set — no SIG and no INS ever observed for any candidate
  //  · unknown   — SIG evidence accumulated but never crossed INS threshold
  //  · cleared   — at least one entity had INS then decayed out of working set
  const anyCleared = [...M.entities.values()].some(e => e.cleared);
  const anyCandidate = M.candidates && M.candidates.size > 0;
  const anyEntity = M.entities.size > 0;
  let nul_state = 'never_set';
  if (anyCleared) nul_state = 'cleared';
  else if (anyCandidate) nul_state = 'unknown';
  else if (anyEntity) nul_state = 'cleared';
  return {
    resolved: false,
    anchor: null,
    grain: null,
    confidence: 0,
    nul_state,
  };
}

// ── Continuous DEF → EVA → REC loop ───────────────────────────

const dirtyQueue = new Set();
let evaLoopRunning = false;

function markDirty(anchorId) {
  if (!anchorId) return;
  dirtyQueue.add(anchorId);
  if (!evaLoopRunning) scheduleEVABatch();
}

function scheduleEVABatch() {
  evaLoopRunning = true;
  setTimeout(processEVABatch, 50);
}

function processEVABatch() {
  const batch = [...dirtyQueue].slice(0, 10);
  batch.forEach(a => {
    dirtyQueue.delete(a);
    runEVAForEntity(a);
  });
  if (dirtyQueue.size > 0) {
    setTimeout(processEVABatch, 16);
  } else {
    evaLoopRunning = false;
    const pressure = Object.fromEntries(M.pressure);
    self.postMessage({ op: 'pressure_update', pressure });
  }
}

function eventIdLocal() { return Math.random().toString(36).slice(2,10); }
function makeEntryLocal(op, anc, target, operand, provenance) {
  return {
    log_id: eventIdLocal(), op, anchor: anc, target, operand, provenance,
    ts: new Date().toISOString(),
  };
}

function anchorLocal(str) {
  let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c + i); h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return '@' + h1.toString(16).padStart(6,'0') + h2.toString(16).padStart(6,'0');
}

function runEVAForEntity(anchorId) {
  const frame = M.defFrames.get(anchorId);
  if (!frame) return;

  const edges = [...M.conEdges.entries()]
    .filter(([k]) => k.startsWith(anchorId + ':') || k.endsWith(':' + anchorId));

  const currentNeighbors = new Set(edges.map(([k]) => {
    const [s, o] = k.split(':');
    return s === anchorId ? o : s;
  }));

  const frameNeighbors = new Set(frame.neighbor_set || []);
  const lost   = [...frameNeighbors].filter(n => !currentNeighbors.has(n));
  const gained = [...currentNeighbors].filter(n => !frameNeighbors.has(n));

  let result;
  if (lost.length === 0 && gained.length === 0) result = 'satisfies';
  else if (lost.length === 0) result = 'extends';
  else if (gained.length === 0) result = 'contracts';
  else result = 'conflicts';

  if (result !== 'satisfies') {
    const evaEntry = makeEntryLocal('EVA',
      anchorLocal(`eva:loop:${anchorId}:${Date.now()}`),
      anchorId, {
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

    const history = M.evaHistory.get(anchorId) || [];
    const recentConflicts = history.filter(e =>
      e.result === 'conflicts' &&
      new Date(e.ts) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    ).length;

    if (recentConflicts >= 3 && frame.is_hub && !M.recPending.has(anchorId)) {
      const recEntry = makeEntryLocal('REC',
        anchorLocal(`rec:loop:${anchorId}`),
        anchorId, {
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
      self.postMessage({ op: 'rec_candidate', anchor: anchorId, rec: recEntry });
    }
  }

  updatePressure(anchorId);
}

// ── Persistence ───────────────────────────────────────────────

async function flushDelta() {
  if (!deltaBuffer.length) return;
  try {
    const root = await navigator.storage.getDirectory();
    const corpus = await root.getDirectoryHandle('corpus');
    const handle = await corpus.getFileHandle('m_delta.ndjson', { create: true });
    let existing = '';
    try { existing = await (await handle.getFile()).text(); } catch {}
    const w = await handle.createWritable();
    await w.write(existing + deltaBuffer.map(e=>JSON.stringify(e)).join('\n') + '\n');
    await w.close();
    deltaBuffer = [];
    checkpointDirty = true;
    if (checkpointDirty) await writeCheckpoint(corpus);
  } catch { /* OPFS unavailable */ deltaBuffer = []; }
}

async function writeCheckpoint(corpus) {
  const cp = {
    entities: Object.fromEntries(
      [...M.entities.entries()].map(([k,v]) => [k, {...v, docs: [...(v.docs || [])]}])
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
  const deltaHandle = await corpus.getFileHandle('m_delta.ndjson', { create: true });
  const dw = await deltaHandle.createWritable();
  await dw.write('');
  await dw.close();
  checkpointDirty = false;
}

function restoreFromCheckpoint(cp) {
  for (const [k,v] of Object.entries(cp.entities||{}))
    M.entities.set(k, {...v, docs: new Set(v.docs || [])});
  for (const [k,v] of Object.entries(cp.defFrames||{}))    M.defFrames.set(k,v);
  for (const [k,v] of Object.entries(cp.conEdges||{}))     M.conEdges.set(k,v);
  for (const [k,v] of Object.entries(cp.evaHistory||{}))   M.evaHistory.set(k,v);
  for (const [k,v] of Object.entries(cp.recPending||{}))   M.recPending.set(k,v);
  for (const [k,v] of Object.entries(cp.pressure||{}))     M.pressure.set(k,v);
  for (const [k,v] of Object.entries(cp.displayNames||{})) M.displayNames.set(k,v);
}

// ── Message router ────────────────────────────────────────────

self.onmessage = async (e) => {
  const { id, op, payload } = e.data || {};
  try {
    if (op === 'init') {
      await init();
      self.postMessage({ id, result: 'ready' });
    } else if (op === 'fold') {
      fold(payload, true);
      self.postMessage({ id, result: 'ok' });
    } else if (op === 'get_entity') {
      const v = M.entities.get(payload.anchor);
      self.postMessage({ id, result: v ? {...v, docs: [...(v.docs||[])]} : null });
    } else if (op === 'get_frame') {
      self.postMessage({ id, result: M.defFrames.get(payload.anchor) || null });
    } else if (op === 'get_pressure') {
      self.postMessage({ id, result: Object.fromEntries(M.pressure) });
    } else if (op === 'get_graph') {
      const entities = {};
      for (const [k,v] of M.entities) entities[k] = {...v, docs: [...(v.docs||[])]};
      self.postMessage({ id, result: {
        nodes: entities,
        edges: Object.fromEntries(M.conEdges),
        displayNames: Object.fromEntries(M.displayNames),
      }});
    } else if (op === 'get_integral_state') {
      const out = {};
      for (const [k, v] of M.entities) {
        out[k] = {
          integral_value: v.integral_value,
          grain_values: v.grain_values,
          coherence_score: v.coherence_score,
          bifurcation_flag: !!v.bifurcation_flag,
          cleared: !!v.cleared,
          ins_coherence: v.ins_coherence,
          last_mention_position: v.last_mention_position,
        };
      }
      const candidates = M.candidates
        ? Object.fromEntries([...M.candidates.entries()].map(([k,c]) => [k, {
            integral_value: c.integral_value, sig_count: c.sig_count,
            normalized: c.normalized,
          }]))
        : {};
      self.postMessage({ id, result: { entities: out, candidates } });
    } else if (op === 'resolve_coreference') {
      self.postMessage({ id, result: resolveCoref(payload) });
    } else if (op === 'flush') {
      await flushDelta();
      self.postMessage({ id, result: 'flushed' });
    } else {
      self.postMessage({ id, error: 'unknown op: ' + op });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
