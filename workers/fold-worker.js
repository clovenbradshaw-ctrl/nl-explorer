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
  candidates:  new Map(), // candidate_anchor → CandidateEntity (pre-INS)
  pendingCons: [],        // [CONEntry] — CONs awaiting INS of one endpoint
  candidateToAnchor: new Map(), // candidate_id → permanent anchor (after INS)
  // Verb integrals per ordered entity pair → { verb → integral_value }
  // Tracks the document's own predicate vocabulary; verbs whose integral
  // crosses VERB_PREDICATE_THRESHOLD become named predicates on the
  // pair's DEF frame.
  verbIntegrals: new Map(), // `${s}:${o}` → Map(verb → number)
  // Per-document last crystallization snapshot for coherence-variance gating.
  lastCrystallized: new Map(), // anchor → { variance, ts }
  // Schema slots declared by the document (e.g. "authorization", "named
  // party"). Each entry: { slot_norm: { ts_first_seen, doc_anchor } }.
  // Used by structural NUL emission.
  schemaSlots: new Map(),

  // ── Proposition layer (rewrite-plan §11) ────────────────────────
  // Proposition anchors (`@p:<hash>`) — claims the document makes. A
  // proposition is a predicate-argument structure that accumulates its
  // own integral via structural matching (§4) and crystallizes a DEF
  // frame once its slot, arguments, and modifiers have stabilized.
  propositions:   new Map(), // @p:<hash> → { subject, predicate_slot, object, modifiers, polarity, stance, evidential, ts, docs:Set }
  // Predicate-slot anchors (`@ps:<hash>`) — the relational slot between
  // a subject and object entity. Multiple Binding CONs accumulate their
  // predicate verb embeddings into the same slot; when the variance
  // drops below θ_DEF the slot crystallizes a predicate class.
  predicateSlots: new Map(), // @ps:<hash> → { subject, object, verbs:Map(verb→count), verb_embeddings:[], predicate_class, crystallized, ts_first_seen }
  // Integral accumulators — I_p(p) and I_slot(p). Kept separate from the
  // entity integral maps so proposition decay can run on its own SEG-
  // boundary λ schedule (rewrite-plan §5).
  propIntegrals:  new Map(), // @p:<hash>  → number
  slotIntegrals:  new Map(), // @ps:<hash> → number
  // DEF frames for propositions — what the claim asserts once its
  // slot is crystallized and its argument anchors are both INS'd.
  propDEFFrames:  new Map(), // @p:<hash>  → { predicate_class, argument_types, modifiers, evidential, resolution }
  // Cultivating events targeting a slot (unknown-NUL precursors, §8).
  // A Cultivating-without-Making pattern flips the NUL state to
  // `unknown` — the document is gesturing without instantiating.
  cultivating:   new Map(), // slot_key → [{ts, doc_anchor, span}]
  // Negation edges — a Clearing CON records the prior proposition it
  // supersedes. Used by EVA conflicts and by the graph render to show
  // prior-proposition demolition rather than silently hiding them.
  negated:       new Map(), // @p:hash → @p:hash (superseding → superseded)
  // Distinction edges — Dissecting results. Entities that were prior
  // conflated and are now explicitly distinguished by the document.
  distinctions:  new Map(), // @e:hash → Set<@e:hash>
};

// Proposition-level thresholds. Kept local so tuning doesn't collide
// with the entity-level integral constants above.
const PROP_INS_THRESHOLD      = 2.5;   // θ_INS for I_p
const SLOT_DEF_VARIANCE       = 0.30;  // θ_DEF for predicate-class variance
const SLOT_CRYSTALLIZE_MIN    = 3;     // minimum Binding events before a slot can crystallize
const PROP_MATCH_WEIGHT = {
  slot:             1.0,   // subject+object match → full-weight accumulation
  predicate_class:  0.8,   // predicate near slot's crystallized centroid
  paraphrase:       0.5,   // LLM structural match (H1) — tier 3
  near_miss:        0.3,
};

// The six-member CON family from §2. `binding` is the only member that
// creates new entity-graph edges; the others operate on existing
// structure. `cooccurrence` is retained as the legacy default so the
// pre-rewrite stageCON_cooccurrence continues to function unchanged.
const CON_TYPES = Object.freeze({
  BINDING:       'binding',
  TRACING:       'tracing',
  TENDING:       'tending',
  CLEARING:      'clearing',
  DISSECTING:    'dissecting',
  UNRAVELING:    'unraveling',
  // Legacy — not part of the Resolution-face family.
  COOCCURRENCE:  'cooccurrence',
});

// Structural-NUL absence_type vocabulary (§8 + §12). Main-thread
// emitters use these to mark why the slot is empty rather than the
// legacy keyword-only NULs.
const NUL_ABSENCE = Object.freeze({
  CULTIVATING_WITHOUT_MAKING:  'cultivating_without_making',
  CONSTITUTIVE_MODIFIER:       'constitutive_modifier',
  PROPOSITION_DECAYED:         'proposition_decayed',
  ENDPOINT_NOT_INSTANTIATED:   'endpoint_not_instantiated', // legacy / premature-CON
  EXPLICIT_CLAIM:              'explicit_claim',            // legacy keyword NUL
});

// Anchor-namespace helpers. The entity anchor stays compatible with the
// legacy `@<hash>` form (anchorLocal) — only the new proposition and
// predicate-slot anchors carry the `@p:` / `@ps:` prefixes required by
// the rewrite plan §1.
function propositionAnchorLocal(subjectAnchor, slotAnchor, objectAnchor) {
  const raw = `p|${subjectAnchor || ''}|${slotAnchor || ''}|${objectAnchor || ''}`;
  return '@p:' + anchorLocal(raw).slice(1); // strip the legacy `@` prefix
}
function predicateSlotAnchorLocal(subjectAnchor, objectAnchor) {
  // Undirected slot key — the plan treats NDP→NDMC and the "received
  // from" reverse direction as the same relational slot (§1, §3).
  const [a, b] = [subjectAnchor || '', objectAnchor || ''].sort();
  return '@ps:' + anchorLocal(`ps|${a}|${b}`).slice(1);
}

// Structural-position multipliers for SIG strength (spec §"The wave fold").
const STRUCTURAL_WEIGHT = {
  subject:  1.0,
  argument: 0.6,
  citation: 0.15,
  default:  0.6,
};

// Verb integral threshold — once a verb between an INS'd pair's integral
// crosses this, it becomes an established predicate for the relationship.
const VERB_PREDICATE_THRESHOLD = 1.5;

// Coherence-variance threshold for DEF crystallization. When the variance
// of a neighborhood's integrals drops below this, the frame is stable.
const DEF_COHERENCE_THRESHOLD = 0.35;

// ── Coref thresholds ──────────────────────────────────────────
// Defaults per docs/coref.md §4 — tunable via COREF_CONFIG_UPDATE message.
const COREF_CONFIG = {
  candidate_new:        0.25,
  ambiguous_low:        0.55,
  merge_confident:      0.72,
  ins_threshold:        4.0,
  working_set:          1.5,
  coherence_warning:    0.60,
  cross_doc_seed:       2.0,
  cross_doc_merge:      0.68,
  resolution_high:      0.75,
  resolution_ambiguous: 0.50,
  // Per-grain base decay (applied on SEG of that grain).
  // Values are the multiplier applied to per-entity grain_values — lower means
  // faster decay. They correspond to λ_base in the spec via exp(-λ·elapsed),
  // collapsed here to a single-step multiplier per SEG event.
  decay: {
    clause:    0.80,
    sentence:  0.55,
    paragraph: 0.36,   // ≈ 1/1.8 → paragraph multiplier from spec
    section:   0.29,   // ≈ 1/3.5
    document:  0.10,   // ≈ 1/10
  },
  // Focus-event signal strengths fed into the integral when the user reads.
  focus_strength: {
    hover: 0.10,
    click: 0.35,
    dwell: 1.00,
  },
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
  // Live ticker feed — main-thread ring buffer (see renderStats area)
  // only listens for this message so we don't flood the UI with
  // every SIG/SEG/NUL entry. INS/DEF/EVA/REC are the operators whose
  // arrival is interesting to a reader watching the learning loop.
  if (entry.op === 'INS' || entry.op === 'DEF' ||
      entry.op === 'EVA' || entry.op === 'REC') {
    try { self.postMessage({ op: 'fold_event', entry }); } catch {}
  }
}

function foldINS(entry) {
  // Proposition-registry INS (rewrite-plan §12): record that the
  // proposition has crossed θ_INS. The proposition record itself was
  // created in registerProposition(); we only mark the op here so
  // downstream consumers (graph render, pressure map) can filter on it.
  if (entry.target === 'proposition-registry') {
    const propAnchor = entry.anchor;
    const prop = M.propositions.get(propAnchor);
    if (prop) {
      prop.insd = true;
      prop.ts_ins = entry.ts;
    }
    return;
  }
  if (entry.target !== 'entity-registry') return;
  const a = entry.anchor;
  const sig_count = entry.provenance?.sig_count || entry.operand?.sig_count_at_ins || 1;
  // If this INS promotes an existing candidate, inherit its accumulated state.
  const cand = M.candidates?.get(a) || (entry.operand?.candidate_id
    ? M.candidates?.get(entry.operand.candidate_id)
    : null);

  if (!M.entities.has(a)) {
    const base = Math.max(1, sig_count);
    M.entities.set(a, {
      anchor: a,
      ops: ['INS'],
      sig_count,
      ts_ins: entry.ts,
      docs: new Set([entry.provenance?.doc_anchor]),
      nul_state: 'active',
      // ── Integral state ───────────────────────────────────────
      // I_e(p) at document position p — accumulated, decayed evidence.
      integral_value: cand?.integral_value ?? base,
      grain_values:   cand?.grain_values?.slice()
                     ?? new Array(grainQueues.length).fill(base),
      coh_mean:       cand?.coh_mean ?? 1,
      coh_m2:         cand?.coh_m2   ?? 0,
      coh_n:          cand?.coh_n    ?? sig_count,
      coherence_score: cand?.coherence_score ?? 1.0,
      accumulated_embedding: cand?.accumulated_embedding ?? null,
      embedding_count:       cand?.embedding_count ?? 0,
      surface_forms:         cand ? [...cand.surface_forms] : [],
      last_mention_position: entry.ts,
      ins_coherence:         cand?.coherence_score ?? 1.0,
      ins_kind:              entry.operand?.kind || null,
      // Stored at INS time so get_entity_anchors can return a
      // {normalized → anchor} map without re-deriving display names.
      normalized:            entry.operand?.display_name || cand?.normalized || null,
      display_name:          entry.operand?.display_name || cand?.normalized || null,
    });
    ensureGrainValues(M.entities.get(a));
    // Promotion: remove the candidate record — it has graduated.
    if (cand) {
      M.candidates.delete(a);
      const cid = entry.operand?.candidate_id;
      if (cid && cid !== a) M.candidates.delete(cid);
    }
  } else {
    const ent = M.entities.get(a);
    ent.docs.add(entry.provenance?.doc_anchor);
    ent.last_mention_position = entry.ts;
    if (ent.cleared) {
      // Re-ignition after decay — the spec allows cleared entities to return
      // to active when new SIGs push them back above INS.
      ent.cleared = false;
      ent.nul_state = 'active';
    }
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

  // Resolution-face CON family dispatch (rewrite-plan §2). Only Binding
  // creates new entity-graph edges. Tracing updates SYN topology.
  // Tending refreshes λ decay on an existing CON — no new edge.
  // Clearing / Dissecting / Unraveling operate on existing structure.
  // When con_type is absent we fall through to the legacy co-occurrence
  // path so the pre-rewrite pipeline continues unchanged.
  const conType = entry.operand?.con_type || null;
  if (conType && conType !== CON_TYPES.COOCCURRENCE) {
    const handled = foldCONTyped(entry, conType, s, o);
    if (handled) return;
  }

  // Premature CON (spec §5.2): if either endpoint is still a pre-INS candidate,
  // queue this CON and emit a NUL marking the deferral. The drainer reprocesses
  // it once both endpoints have INS'd.
  const sReady = M.entities.has(s);
  const oReady = M.entities.has(o);
  const isMerge = entry.operand?.kind === 'entity_merge'
               || entry.operand?.kind === 'cross_doc_merge_candidate'
               || entry.operand?.kind === 'cross_doc_entity';
  if ((!sReady || !oReady) && !entry.operand?.__deferred_retry && !isMerge) {
    M.pendingCons.push(entry);
    entry.operand.__deferred_retry = true; // prevent re-queue
    const nulEntry = makeEntryLocal('NUL',
      anchorLocal(`nul:premature:${s}:${o}:${Date.now()}`),
      s, {
        kind: 'premature_con',
        signal: 'premature_con',
        absence_type: 'endpoint_not_instantiated',
        subject_anchor: s,
        object_anchor: o,
        subject_ready: sReady,
        object_ready: oReady,
      }, {
        source: 'mechanical:integral_fold',
        doc_anchor: entry.provenance?.doc_anchor,
        confidence: 0.9,
      });
    fold(nulEntry);
    return;
  }

  // Entity merge CON (spec §2.4) — one anchor absorbs the other.
  if (entry.operand?.kind === 'entity_merge') {
    const primary  = entry.operand.primary_anchor  || s;
    const absorbed = entry.operand.absorbed_anchor || o;
    const abs = M.entities.get(absorbed);
    const pri = M.entities.get(primary);
    if (pri && abs) {
      pri.integral_value = (pri.integral_value || 0) + (abs.integral_value || 0);
      pri.sig_count     = (pri.sig_count || 0) + (abs.sig_count || 0);
      (abs.docs || []).forEach(d => pri.docs.add(d));
      pri.surface_forms = [...new Set([...(pri.surface_forms||[]), ...(abs.surface_forms||[])])];
      abs.merged_into = primary;
      abs.nul_state = 'cleared';
    }
  }

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

  // Verb integral tracking (spec §"The document builds its own predicate
  // vocabulary"). Increment integral for the surface verb between this
  // pair; once it crosses VERB_PREDICATE_THRESHOLD the verb is treated
  // as a named predicate at frame crystallization.
  const verb = entry.operand?.verb;
  if (verb && typeof verb === 'string') {
    const vKey = key;
    if (!M.verbIntegrals.has(vKey)) M.verbIntegrals.set(vKey, new Map());
    const vMap = M.verbIntegrals.get(vKey);
    const vNorm = verb.trim().toLowerCase();
    vMap.set(vNorm, (vMap.get(vNorm) || 0) + (entry.provenance?.confidence || 0.6));
  }

  markDirty(s);
  markDirty(o);
}

// ── Resolution-face CON family (rewrite-plan §2) ──────────────
// Returns true if the entry was fully handled in the typed path and
// should NOT fall through to the legacy co-occurrence code. Returns
// false when the preconditions failed and the caller should degrade
// gracefully (legacy path or DAG-violation NUL).
function foldCONTyped(entry, conType, s, o) {
  const bothInsd = M.entities.has(s) && M.entities.has(o);
  const predicateSlotAnchor = predicateSlotAnchorLocal(s, o);
  const objAnchor = o;
  const conf = entry.provenance?.confidence ?? 0.6;

  switch (conType) {
    case CON_TYPES.BINDING: {
      // Precondition (plan §2): both endpoints must be INS'd.
      if (!bothInsd) {
        emitWellFormednessNUL(entry, conType, 'endpoints_not_instantiated');
        return false;
      }
      // Create / refresh the predicate slot and accumulate its
      // predicate-verb integral. This is the mechanism that drives per-
      // slot DEF crystallization in §3.
      accumulateIntoSlot(predicateSlotAnchor, s, o, entry);
      // Create or update the proposition anchor. Multiple Binding
      // events in the same slot with compatible object_anchors map to
      // the same proposition integral (§4 tier 1: slot match).
      const propAnchor = registerProposition(entry, s, o, predicateSlotAnchor);
      accumulatePropositionIntegral(propAnchor, entry, PROP_MATCH_WEIGHT.slot);
      // Only Binding creates entity-graph edges — this is the
      // architectural commitment that prevents the hairball.
      writeEntityEdge(s, o, entry, predicateSlotAnchor, propAnchor);
      markDirty(s); markDirty(o);
      return true;
    }
    case CON_TYPES.TENDING: {
      // Tending modifies λ, not σ (plan §5). It refreshes an existing
      // edge's decay without pushing its integral past θ_INS. If no
      // prior CON exists for this pair the document is invoking a
      // relationship the reader is expected to supply — emit a
      // well-formedness NUL (§2).
      const key = `${s}:${o}`;
      const edge = M.conEdges.get(key) || M.conEdges.get(`${o}:${s}`);
      if (!edge) {
        emitWellFormednessNUL(entry, conType, 'tending_without_prior_con');
        return true;
      }
      edge.last_tend_ts = entry.ts;
      edge.tend_count = (edge.tend_count || 0) + 1;
      // Refresh slot integral without triggering proposition INS.
      bumpSlotLambda(predicateSlotAnchor);
      return true;
    }
    case CON_TYPES.CLEARING: {
      // Negate a prior proposition. §2: "demolishing a frame that was
      // never built in this corpus" emits a presupposition-gap NUL.
      const targetPropAnchor = entry.operand?.supersedes
        || findPriorPropositionForPair(s, o);
      if (!targetPropAnchor) {
        emitWellFormednessNUL(entry, conType, 'clearing_without_prior_proposition');
        return true;
      }
      M.negated.set(entry.anchor, targetPropAnchor);
      const prop = M.propositions.get(targetPropAnchor);
      if (prop) {
        prop.superseded_by = entry.anchor;
        prop.polarity = 'NEGATED';
      }
      return true;
    }
    case CON_TYPES.DISSECTING: {
      // Distinction edge — both endpoints must exist and have been
      // prior-conflated somewhere in the corpus.
      if (!bothInsd) {
        emitWellFormednessNUL(entry, conType, 'dissecting_requires_insd_endpoints');
        return false;
      }
      if (!M.distinctions.has(s)) M.distinctions.set(s, new Set());
      if (!M.distinctions.has(o)) M.distinctions.set(o, new Set());
      M.distinctions.get(s).add(o);
      M.distinctions.get(o).add(s);
      return true;
    }
    case CON_TYPES.TRACING: {
      // Pattern-level — the proposition itself is a pattern across ≥2
      // supporting Binding pairs. Route through SYN rather than the
      // entity edge graph.
      const supports = entry.operand?.supporting_bindings || [];
      if (supports.length < 2) {
        emitWellFormednessNUL(entry, conType, 'tracing_without_binding_support');
        return true;
      }
      // Emit a synthesized SYN update via the same markDirty path so
      // the continuous loop picks it up.
      markDirty(s); markDirty(o);
      return true;
    }
    case CON_TYPES.UNRAVELING: {
      // Weakens an existing SYN node's coherence. Not an entity-graph
      // operation — just mark the target SYN node for re-evaluation.
      const synTarget = entry.operand?.syn_anchor;
      if (!synTarget) {
        emitWellFormednessNUL(entry, conType, 'unraveling_requires_syn_target');
        return true;
      }
      markDirty(synTarget);
      return true;
    }
  }
  return false;
}

function emitWellFormednessNUL(entry, conType, reason) {
  const nul = makeEntryLocal('NUL',
    anchorLocal(`nul:wellformed:${conType}:${entry.anchor}`),
    entry.target, {
      absence_type: 'presupposition_gap',
      con_type: conType,
      reason,
      signal: reason,
      object_anchor: entry.operand?.object_anchor,
      note: `DAG violation: ${conType} without required dependency`,
    }, {
      source: 'mechanical:con_wellformedness',
      doc_anchor: entry.provenance?.doc_anchor,
      span_start: entry.provenance?.span_start,
      span_end: entry.provenance?.span_end,
      confidence: 0.85,
    });
  fold(nul);
}

// Accumulate the predicate-verb evidence for a slot. Once the slot has
// seen enough Binding events with low predicate-embedding variance we
// can crystallize a predicate class (plan §3) — the emission itself
// happens in crystallizeSlots(); this function just updates state.
function accumulateIntoSlot(slotAnchor, s, o, entry) {
  let slot = M.predicateSlots.get(slotAnchor);
  if (!slot) {
    slot = {
      anchor: slotAnchor,
      subject: s,
      object: o,
      verbs: new Map(),          // verb → count
      verb_embeddings: [],        // raw embeddings from classifier (§3)
      predicate_class: null,      // crystallized medoid verb
      crystallized: false,
      ts_first_seen: entry.ts,
      doc_anchors: new Set(),
    };
    M.predicateSlots.set(slotAnchor, slot);
  }
  const verb = (entry.operand?.predicate_token
             || entry.operand?.verb
             || entry.operand?.predicate
             || '').trim().toLowerCase();
  if (verb) slot.verbs.set(verb, (slot.verbs.get(verb) || 0) + 1);
  const emb = entry.operand?.predicate_embedding;
  if (Array.isArray(emb) && emb.length) slot.verb_embeddings.push(emb);
  if (entry.provenance?.doc_anchor) slot.doc_anchors.add(entry.provenance.doc_anchor);
  // Slot integral accumulates the confidence of each supporting Binding.
  const cur = M.slotIntegrals.get(slotAnchor) || 0;
  M.slotIntegrals.set(slotAnchor,
    cur + (entry.provenance?.confidence ?? 0.6));
}

function bumpSlotLambda(slotAnchor) {
  // Tending suppresses decay on the slot's integral without adding σ.
  // In this discrete implementation we just mark the slot as recently
  // tended so the next SEG boundary applies a smaller multiplier.
  const slot = M.predicateSlots.get(slotAnchor);
  if (slot) slot.last_tend_ts = Date.now();
}

// Register or re-register a proposition anchor for a (subject, slot,
// object) triple. Idempotent — multiple Binding events on the same
// slot/object map to the same @p anchor so their integrals accumulate.
function registerProposition(entry, s, o, slotAnchor) {
  const propAnchor = propositionAnchorLocal(s, slotAnchor, o);
  let prop = M.propositions.get(propAnchor);
  if (!prop) {
    prop = {
      anchor: propAnchor,
      subject: s,
      object: o,
      predicate_slot: slotAnchor,
      modifiers: Array.isArray(entry.operand?.modifiers)
        ? entry.operand.modifiers.slice() : [],
      polarity:  entry.operand?.polarity   || 'ASSERTED',
      stance:    entry.operand?.stance     || 'Binding',
      evidential: entry.operand?.evidential || null,
      ts:        entry.ts,
      docs:      new Set(entry.provenance?.doc_anchor
        ? [entry.provenance.doc_anchor] : []),
      support_count: 0,
    };
    M.propositions.set(propAnchor, prop);
  } else {
    if (entry.provenance?.doc_anchor) prop.docs.add(entry.provenance.doc_anchor);
    // Merge modifiers — preserving constitutive absences (§2).
    if (Array.isArray(entry.operand?.modifiers)) {
      for (const m of entry.operand.modifiers) prop.modifiers.push(m);
    }
  }
  prop.support_count++;
  return propAnchor;
}

function accumulatePropositionIntegral(propAnchor, entry, matchWeight) {
  const sigma = (entry.provenance?.confidence ?? 0.6) * matchWeight;
  const next = (M.propIntegrals.get(propAnchor) || 0) + sigma;
  M.propIntegrals.set(propAnchor, next);
  // Proposition INS fires once I_p crosses θ_INS. Emit an INS entry
  // against the `proposition-registry` target so foldINS can record
  // the proposition as established (plan §12).
  if (next >= PROP_INS_THRESHOLD) {
    const prop = M.propositions.get(propAnchor);
    if (prop && !prop.insd) {
      prop.insd = true;
      const insEntry = makeEntryLocal('INS',
        propAnchor, 'proposition-registry', {
          anchor_type: 'proposition',
          subject: prop.subject,
          predicate_slot: prop.predicate_slot,
          object: prop.object,
          integral_at_ins: parseFloat(next.toFixed(3)),
          support_count: prop.support_count,
        }, {
          source: 'mechanical:proposition_ins',
          doc_anchor: entry.provenance?.doc_anchor,
          confidence: Math.min(0.95, next / PROP_INS_THRESHOLD * 0.5),
        });
      fold(insEntry);
    }
  }
}

function writeEntityEdge(s, o, entry, slotAnchor, propAnchor) {
  const key = `${s}:${o}`;
  const existing = M.conEdges.get(key);
  const predicate = entry.operand?.predicate_token
                 || entry.operand?.verb
                 || entry.operand?.relation_type
                 || 'related';
  if (existing) {
    existing.confidence = Math.min(0.99, existing.confidence + 0.05);
    existing.sources.push(entry.provenance?.doc_anchor);
    existing.count++;
    existing.predicate_slot = slotAnchor;
    existing.con_type = CON_TYPES.BINDING;
    (existing.propositions ||= []).push(propAnchor);
  } else {
    M.conEdges.set(key, {
      s, o,
      predicate,
      predicate_slot: slotAnchor,
      con_type: CON_TYPES.BINDING,
      propositions: [propAnchor],
      confidence: entry.provenance?.confidence || 0.5,
      sources: [entry.provenance?.doc_anchor],
      count: 1,
      ts: entry.ts,
    });
  }
  const ent = M.entities.get(s);
  if (ent && !ent.ops.includes('CON')) ent.ops.push('CON');
}

function findPriorPropositionForPair(s, o) {
  // First match wins — used by Clearing when it doesn't name a specific
  // supersedes target. Returns null when no prior proposition exists
  // between the pair (caller emits presupposition_gap NUL).
  for (const [anc, p] of M.propositions) {
    if ((p.subject === s && p.object === o) ||
        (p.subject === o && p.object === s)) return anc;
  }
  return null;
}

// Slot DEF crystallization (plan §3). When a slot's predicate-
// embedding variance drops below SLOT_DEF_VARIANCE and it has at least
// SLOT_CRYSTALLIZE_MIN supports, emit a DEF entry naming the slot's
// predicate class. Invoked from the `crystallize_slots` op router.
function crystallizeSlots(docAnchor) {
  let emitted = 0;
  for (const [slotAnchor, slot] of M.predicateSlots) {
    if (slot.crystallized) continue;
    if (docAnchor && !slot.doc_anchors.has(docAnchor)) continue;
    const supports = [...slot.verbs.values()].reduce((a,b)=>a+b, 0);
    if (supports < SLOT_CRYSTALLIZE_MIN) continue;

    // Variance of the predicate-verb counts (proxy for embedding
    // variance when no embedding is supplied — the full embedding
    // variance path is available when the main thread feeds
    // `predicate_embedding` into each Binding CON).
    const embVar = slot.verb_embeddings.length >= 2
      ? embeddingVariance(slot.verb_embeddings)
      : surfaceVerbVariance(slot.verbs);
    if (embVar > SLOT_DEF_VARIANCE) {
      // High variance → bifurcation pressure (plan §3).
      emitSlotBifurcationREC(slotAnchor, slot, embVar, docAnchor);
      continue;
    }

    const medoid = pickMedoidVerb(slot);
    slot.predicate_class = medoid;
    slot.crystallized = true;

    const defEntry = makeEntryLocal('DEF',
      anchorLocal('def:slot:' + slotAnchor + ':' + (docAnchor || 'global')),
      slotAnchor, {
        param: 'predicate_class',
        value: medoid,
        slot_subject: slot.subject,
        slot_object:  slot.object,
        supporting_verbs: Object.fromEntries(slot.verbs),
        variance: parseFloat(embVar.toFixed(4)),
        note: 'crystallized per-slot predicate class',
        resolution: 'full',
      }, {
        source: 'mechanical:slot_crystallization',
        doc_anchor: docAnchor,
        confidence: 0.9,
      });
    fold(defEntry);
    emitted++;
  }
  return { emitted };
}

function embeddingVariance(embeddings) {
  const n = embeddings.length;
  const dim = embeddings[0].length;
  const mean = new Array(dim).fill(0);
  for (const e of embeddings) for (let i=0;i<dim;i++) mean[i] += e[i];
  for (let i=0;i<dim;i++) mean[i] /= n;
  let v = 0;
  for (const e of embeddings) {
    for (let i=0;i<dim;i++) v += (e[i]-mean[i])**2;
  }
  return v / (n * dim);
}

function surfaceVerbVariance(verbMap) {
  // Fallback: normalized entropy of the verb distribution. High entropy
  // ⇒ many different verbs ⇒ high variance.
  const counts = [...verbMap.values()];
  if (counts.length < 2) return 0;
  const total = counts.reduce((a,b)=>a+b, 0);
  let h = 0;
  for (const c of counts) {
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(counts.length); // normalized 0..1
}

function pickMedoidVerb(slot) {
  // Without embeddings: return the most-frequent verb.
  let best = null, max = -1;
  for (const [v, c] of slot.verbs) {
    if (c > max) { max = c; best = v; }
  }
  return best || 'related';
}

function emitSlotBifurcationREC(slotAnchor, slot, variance, docAnchor) {
  const rec = makeEntryLocal('REC',
    anchorLocal('rec:slot_bifurcation:' + slotAnchor),
    slotAnchor, {
      trigger: 'slot_predicate_bifurcation',
      variance: parseFloat(variance.toFixed(4)),
      slot_subject: slot.subject,
      slot_object:  slot.object,
      note: 'Two relational types conflated under one subject/object pair',
      resolution: 'pending_human',
    }, {
      source: 'mechanical:slot_bifurcation',
      doc_anchor: docAnchor,
      confidence: 0.75,
    });
  fold(rec);
}

// Established predicates for an entity pair — verbs whose integral has
// crossed VERB_PREDICATE_THRESHOLD, sorted high → low.
function establishedPredicatesFor(s, o) {
  const out = [];
  const fwd = M.verbIntegrals.get(`${s}:${o}`);
  const rev = M.verbIntegrals.get(`${o}:${s}`);
  const merged = new Map();
  if (fwd) for (const [v, n] of fwd) merged.set(v, (merged.get(v) || 0) + n);
  if (rev) for (const [v, n] of rev) merged.set(v, (merged.get(v) || 0) + n);
  for (const [v, n] of merged) {
    if (n >= VERB_PREDICATE_THRESHOLD) out.push({ verb: v, integral: parseFloat(n.toFixed(3)) });
  }
  out.sort((a, b) => b.integral - a.integral);
  return out;
}

// Coherence variance over an entity's INS'd neighbour set — variance of
// neighbour integral values. Low variance ⇒ a stable, crystallized frame
// (spec §"Coherence variance as the DEF crystallization signal").
function neighborhoodVariance(anchor) {
  const neigh = [];
  for (const [k, edge] of M.conEdges) {
    if (k.startsWith(anchor + ':') || k.endsWith(':' + anchor)) {
      const other = edge.s === anchor ? edge.o : edge.s;
      const oent = M.entities.get(other);
      if (oent) neigh.push(oent.integral_value || 0);
    }
  }
  if (neigh.length < 2) return { variance: Infinity, count: neigh.length, neighbors: neigh };
  const mean = neigh.reduce((a, b) => a + b, 0) / neigh.length;
  const variance = neigh.reduce((a, b) => a + (b - mean) ** 2, 0) / neigh.length;
  return { variance, count: neigh.length, neighbors: neigh };
}

// Crystallize DEF frames for entities whose neighbourhood coherence
// variance has dropped below DEF_COHERENCE_THRESHOLD since the last
// crystallization. Replaces the main-thread snapshot stageFrameDEF.
function crystallizeFrames(doc_anchor) {
  let emitted = 0;
  for (const [a, ent] of M.entities) {
    if (!ent.ops.includes('INS')) continue;
    if (doc_anchor && !ent.docs?.has?.(doc_anchor)) continue;

    const { variance, count, neighbors } = neighborhoodVariance(a);
    if (count < 2) continue;

    const last = M.lastCrystallized.get(a);
    // Re-crystallize only if this is the first time, or variance dropped
    // meaningfully since the last snapshot.
    const droppedEnough = !last || (last.variance - variance) > 0.05;
    if (variance > DEF_COHERENCE_THRESHOLD && !droppedEnough) continue;

    // Build neighbour set with integral values
    const neighborSet = [];
    const neighborWithIntegrals = [];
    const relationTypes = new Set();
    for (const [k, edge] of M.conEdges) {
      let other = null;
      if (k.startsWith(a + ':')) other = edge.o;
      else if (k.endsWith(':' + a)) other = edge.s;
      if (!other) continue;
      const oent = M.entities.get(other);
      if (!oent) continue;
      neighborSet.push(other);
      neighborWithIntegrals.push({ anchor: other, integral: oent.integral_value || 0 });
      if (edge.predicate) relationTypes.add(edge.predicate);
    }

    // Established predicates across all neighbours (verbs that crossed
    // the predicate threshold in the document's own usage).
    const predicates = [];
    for (const n of neighborSet) {
      const verbs = establishedPredicatesFor(a, n);
      for (const v of verbs) predicates.push({ neighbor: n, ...v });
    }

    const displayName = M.displayNames.get(a) || a;
    const labelNames = neighborWithIntegrals
      .slice()
      .sort((x, y) => y.integral - x.integral)
      .slice(0, 3)
      .map(x => M.displayNames.get(x.anchor) || x.anchor)
      .join(', ');
    const frame_label = `${displayName}: related to ${labelNames}` +
      (predicates.length ? ` via ${[...new Set(predicates.map(p => p.verb))].slice(0, 2).join(', ')}` : '');

    const defEntry = makeEntryLocal('DEF',
      anchorLocal('def:frame:' + a + ':' + (doc_anchor || 'global')),
      a, {
        param: 'frame',
        value: anchorLocal(neighborSet.sort().join(':') + '|' + [...relationTypes].sort().join(':')),
        frame_label,
        neighbor_count: neighborSet.length,
        neighbor_set: neighborSet,
        neighbor_integrals: neighborWithIntegrals,
        relation_types: [...relationTypes].sort(),
        established_predicates: predicates,
        coherence_variance: parseFloat(variance.toFixed(4)),
        is_hub: !!ent.is_hub,
        doc_anchor,
        note: 'crystallized from coherence variance drop',
        resolution: null,
      }, {
        source: 'mechanical:frame_crystallization',
        doc_anchor,
        confidence: 0.9,
      });
    fold(defEntry);
    M.lastCrystallized.set(a, { variance, ts: Date.now() });
    emitted++;
  }
  return { emitted };
}

// Structural NUL classification from integral history (spec §"Three NUL
// states from integral history"). Given a slot name, return the state of
// the document's evidence for that slot at the current position.
function nulStateForSlot(slotNorm) {
  // Look for a candidate or entity whose normalized form matches the slot.
  const slotKey = slotNorm.trim().toLowerCase();
  for (const ent of M.entities.values()) {
    const norm = ent.normalized || ent.display_name || '';
    if (norm.toLowerCase() === slotKey) {
      if (ent.cleared) return { state: 'cleared', integral: ent.integral_value };
      return { state: 'active', integral: ent.integral_value };
    }
  }
  if (M.candidates) {
    for (const c of M.candidates.values()) {
      if ((c.normalized || '').toLowerCase() === slotKey) {
        return { state: 'unknown', integral: c.integral_value };
      }
    }
  }
  return { state: 'never_set', integral: 0 };
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
  if (det !== 'NP' && det !== 'ACCUMULATION' && det !== 'FOCUS') return;
  const target = entry.target && entry.target.startsWith('@')
    ? entry.target
    : (entry.operand?.normalized ? anchorLocal('np:' + entry.operand.normalized) : null);
  if (!target) return;

  // Structural-position weighting (spec §"The wave fold"). The emitter may
  // tag the SIG with operand.structural_position ∈ {subject, argument,
  // citation}. Default falls back to the prior confidence-only behaviour
  // so emitters that don't yet attach position aren't penalised.
  const baseConf = entry.provenance?.confidence || 0.5;
  const posKind = entry.operand?.structural_position;
  const posMult = posKind && STRUCTURAL_WEIGHT[posKind] !== undefined
    ? STRUCTURAL_WEIGHT[posKind]
    : 1.0;
  const strength = Math.max(0.1, baseConf * posMult);
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
      anchor: target,
      integral_value: 0,
      sig_count: 0,
      first_seen: entry.ts,
      normalized: entry.operand?.normalized,
      // Welford accumulator for a running mean embedding (spec §2.1).
      accumulated_embedding: null,
      embedding_count: 0,
      surface_forms: new Set(),
      coh_mean: 0, coh_m2: 0, coh_n: 0, coherence_score: 1.0,
      grain_values: new Array(grainQueues.length).fill(0),
      nul_state: 'unknown',
      bifurcation_warning: false,
      last_sig_position: entry.ts,
    };
    c.integral_value += strength;
    const gv = ensureGrainValues(c);
    for (let g = 0; g < gv.length; g++) gv[g] += strength;
    c.sig_count += 1;
    c.last_seen = entry.ts;
    c.last_sig_position = entry.ts;
    const sf = entry.operand?.text;
    if (sf) c.surface_forms.add(sf);

    // Welford mean of the mention embedding (when provided).
    const emb = entry.operand?.embedding;
    if (Array.isArray(emb) && emb.length > 0) {
      if (!c.accumulated_embedding) {
        c.accumulated_embedding = new Float32Array(emb.length);
      }
      c.embedding_count += 1;
      const n = c.embedding_count;
      for (let i = 0; i < emb.length; i++) {
        c.accumulated_embedding[i] += (emb[i] - c.accumulated_embedding[i]) / n;
      }
    }

    // Welford variance on signal strength for coherence score.
    c.coh_n += 1;
    const dCoh = strength - c.coh_mean;
    c.coh_mean += dCoh / c.coh_n;
    c.coh_m2   += dCoh * (strength - c.coh_mean);
    const variance = c.coh_n > 1 ? c.coh_m2 / (c.coh_n - 1) : 0;
    c.coherence_score = 1 / (1 + variance);

    M.candidates.set(target, c);

    // Integral threshold crossing (spec §1.2, §3.1) — emit an INS so this
    // candidate crystallises into a first-class entity. Fold the INS locally
    // so downstream processing observes the promotion in the same tick.
    if (c.integral_value >= COREF_CONFIG.ins_threshold && c.nul_state === 'unknown') {
      c.nul_state = 'active';
      const displayName = c.normalized || (sf || target);
      const insEntry = makeEntryLocal('INS', target, 'entity-registry', {
        kind: 'integral_threshold_crossing',
        display_name: displayName,
        integral_at_ins: c.integral_value,
        coherence_at_ins: c.coherence_score,
        sig_count_at_ins: c.sig_count,
        candidate_id: target,
        nul_state_prior: 'unknown',
      }, {
        source: 'mechanical:integral_fold',
        sig_count: c.sig_count,
        doc_anchor: entry.provenance?.doc_anchor,
        confidence: Math.min(0.6 + c.sig_count * 0.02, 0.95),
      });
      // Record the candidate-id → anchor mapping (identity in this case, since
      // we chose the candidate's own anchor as the permanent one).
      M.candidateToAnchor.set(target, target);
      fold(insEntry);
      // Drain any CONs that were deferred waiting on this endpoint.
      drainPendingCons();
    }
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
  const kind = entry.operand?.kind;
  // Bifurcation SEG (spec §2.4) — split one integral into two anchors.
  if (kind === 'entity_bifurcation') {
    const orig = entry.operand.original_anchor;
    const ent  = orig ? M.entities.get(orig) : null;
    if (ent) {
      ent.bifurcation_resolved = true;
      ent.bifurcation_flag = false;
      ent.split_into = [entry.operand.new_anchor_a, entry.operand.new_anchor_b];
    }
    return;
  }
  const g = grainForBoundary(entry.operand?.type);
  if (g < 0) return;
  const before = countAboveWorkingSet(g);
  decayAtBoundary(g);
  const after  = countAboveWorkingSet(g);
  // Attach working-set stats inline on the operand (no new log entry — this is
  // the same SEG; stats are diagnostic so the inspector can render them).
  if (entry.operand) {
    entry.operand.entities_above_ws = before;
    entry.operand.entities_retained = after;
  }
}

function countAboveWorkingSet(grain) {
  const theta = COREF_CONFIG.working_set;
  let n = 0;
  for (const ent of M.entities.values()) {
    const gv = ent.grain_values;
    const iv = gv ? gv[grain] ?? ent.integral_value : ent.integral_value;
    if ((iv || 0) >= theta) n++;
  }
  return n;
}

function foldNUL(entry) {
  const a = entry.target;
  const absType = entry.operand?.absence_type;

  // Structural-NUL routing (rewrite-plan §8). Constitutive-modifier
  // NULs project onto proposition anchors rather than entity anchors.
  // Proposition-decayed NULs clear the proposition's `insd` flag.
  if (absType === NUL_ABSENCE.CONSTITUTIVE_MODIFIER) {
    const propAnchor = entry.operand?.proposition_anchor;
    const prop = propAnchor && M.propositions.get(propAnchor);
    if (prop) {
      (prop.modifiers ||= []).push({
        type: entry.operand?.modifier_type || 'negation',
        content: entry.operand?.content,
        polarity: 'NEGATED',
        nul_backed: true,
      });
    }
    return;
  }
  if (absType === NUL_ABSENCE.PROPOSITION_DECAYED) {
    const propAnchor = entry.operand?.proposition_anchor || a;
    const prop = M.propositions.get(propAnchor);
    if (prop) {
      prop.cleared = true;
      prop.insd = false;
    }
    return;
  }
  if (absType === NUL_ABSENCE.CULTIVATING_WITHOUT_MAKING) {
    // The main-thread stageNUL_structural emits this after detecting
    // Cultivating-without-Making; we just record it so the pressure
    // loop can surface it as REC when the pattern persists.
    const slotKey = (entry.operand?.slot || a || '').toLowerCase();
    if (!M.cultivating.has(slotKey)) M.cultivating.set(slotKey, []);
    M.cultivating.get(slotKey).push({
      ts: entry.ts,
      doc_anchor: entry.provenance?.doc_anchor,
      span_start: entry.provenance?.span_start,
    });
    return;
  }

  if (M.entities.has(a)) {
    const ent = M.entities.get(a);
    if (!ent.nul_signals) ent.nul_signals = [];
    ent.nul_signals.push({
      signal: entry.operand?.signal,
      absence_type: absType,
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

// Five grains cover the boundary types named in the spec (§2.2).
// TOKEN grain is collapsed into CLAUSE for now — emitters only produce clause
// SEGs and narrower SIGs, so adding a token queue would store no useful state.
const GRAIN = { CLAUSE: 0, SENTENCE: 1, PARAGRAPH: 2, SECTION: 3, DOCUMENT: 4 };
// Multipliers applied when a SEG boundary fires at that grain. Used only as a
// fallback; COREF_CONFIG.decay drives the actual decay computation below.
const DECAY = [0.80, 0.55, 0.36, 0.29, 0.10];
const grainQueues = [[], [], [], [], []];

function grainForBoundary(type) {
  switch (type) {
    case 'clause':    return GRAIN.CLAUSE;
    case 'sentence':  return GRAIN.SENTENCE;
    case 'paragraph': return GRAIN.PARAGRAPH;
    case 'section':   return GRAIN.SECTION;
    case 'document':  return GRAIN.DOCUMENT;
    default:          return -1;
  }
}

function decayMultiplierForGrain(grain) {
  const cfg = COREF_CONFIG.decay;
  switch (grain) {
    case GRAIN.CLAUSE:    return cfg.clause;
    case GRAIN.SENTENCE:  return cfg.sentence;
    case GRAIN.PARAGRAPH: return cfg.paragraph;
    case GRAIN.SECTION:   return cfg.section;
    case GRAIN.DOCUMENT:  return cfg.document;
    default:              return DECAY[grain] ?? 0.5;
  }
}

function pushToQueues(anchorId, position) {
  for (let g = 0; g < grainQueues.length; g++) {
    grainQueues[g].push({ anchor: anchorId, weight: 1.0, position });
  }
}

function ensureGrainValues(rec) {
  if (!rec.grain_values) {
    rec.grain_values = new Array(grainQueues.length).fill(rec.integral_value || 0);
  } else if (rec.grain_values.length < grainQueues.length) {
    // Older records persisted with 4 grains; pad to include SECTION.
    const last = rec.grain_values[rec.grain_values.length - 1] || 0;
    while (rec.grain_values.length < grainQueues.length) rec.grain_values.push(last);
  }
  return rec.grain_values;
}

function decayAtBoundary(grainLevel) {
  if (grainLevel < 0) return;
  // Decay grain-queue weights at and below this boundary.
  for (let g = 0; g <= grainLevel; g++) {
    const mult = decayMultiplierForGrain(g);
    grainQueues[g] = grainQueues[g]
      .map(e => ({ ...e, weight: e.weight * mult }))
      .filter(e => e.weight > 0.02);
  }
  // Decay per-entity grain integrals up to and including this grain.
  // Paragraph SEG → higher λ_e; section/document SEG → near-zero except prominent.
  for (const ent of M.entities.values()) {
    const grain_values = ensureGrainValues(ent);
    for (let g = 0; g <= grainLevel; g++) {
      grain_values[g] *= decayMultiplierForGrain(g);
    }
    // Top-level integral tracks the coarsest active grain.
    ent.integral_value = grain_values[grainLevel];
    // Mark cleared if we've decayed below working-set after INS.
    if (ent.integral_value < 0.05 && ent.ops?.includes('INS') && !ent.cleared) {
      ent.cleared = true;
      ent.nul_state = 'cleared';
    }
  }
  // Decay pre-INS candidates too — evidence that never crossed threshold
  // fades and eventually drops out of the working set.
  if (M.candidates) {
    const mult = decayMultiplierForGrain(grainLevel);
    for (const [k, c] of M.candidates) {
      c.integral_value *= mult;
      const gv = ensureGrainValues(c);
      for (let g = 0; g <= grainLevel; g++) gv[g] *= decayMultiplierForGrain(g);
      if (c.integral_value < 0.05) M.candidates.delete(k);
    }
  }
}

// Replay CONs that were deferred because one endpoint was still a candidate.
// Called whenever an INS promotion occurs (spec §5.2).
function drainPendingCons() {
  if (!M.pendingCons.length) return;
  const stillPending = [];
  for (const con of M.pendingCons) {
    const s = con.target;
    const o = con.operand?.object_anchor;
    if (s && o && M.entities.has(s) && M.entities.has(o)) {
      // Clear the retry guard so foldCON processes it on the merge-edge path.
      con.operand.__deferred_retry = false;
      fold(con, false);
    } else {
      stillPending.push(con);
    }
  }
  M.pendingCons = stillPending;
}

// Focus-driven SIG (spec §6) — a reading-session signal produced by the
// explorer UI. Updates the entity's integral live so the inspector reflects
// the user's current attention. Unlike mechanical SIGs, focus events always
// target an anchor that is already (or about to be) in M.
function handleFocusSig(payload) {
  const { anchor: a, strength: kind, embedding, doc_anchor } = payload || {};
  if (!a) return { ok: false, error: 'missing anchor' };
  const sigma = COREF_CONFIG.focus_strength[kind] ?? COREF_CONFIG.focus_strength.hover;
  const sigEntry = makeEntryLocal('SIG',
    anchorLocal(`focus:${kind}:${a}:${Date.now()}`),
    a, {
      text: kind,
      normalized: a,
      detector: kind === 'dwell' ? 'FOCUS' : 'NP',
      focus_kind: kind,
      embedding: Array.isArray(embedding) ? embedding : undefined,
    }, {
      source: `focus:${kind}`,
      doc_anchor,
      confidence: sigma,
    });
  fold(sigEntry);
  return { ok: true, strength: sigma };
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
    // Proposition layer (rewrite-plan §11).
    propositions: Object.fromEntries(
      [...M.propositions.entries()].map(([k, v]) => [k, {
        ...v, docs: [...(v.docs || [])],
      }])
    ),
    predicateSlots: Object.fromEntries(
      [...M.predicateSlots.entries()].map(([k, v]) => [k, {
        ...v,
        verbs: Object.fromEntries(v.verbs || []),
        doc_anchors: [...(v.doc_anchors || [])],
      }])
    ),
    propIntegrals: Object.fromEntries(M.propIntegrals),
    slotIntegrals: Object.fromEntries(M.slotIntegrals),
    propDEFFrames: Object.fromEntries(M.propDEFFrames),
    cultivating:   Object.fromEntries(M.cultivating),
    negated:       Object.fromEntries(M.negated),
    distinctions:  Object.fromEntries(
      [...M.distinctions.entries()].map(([k, v]) => [k, [...v]])
    ),
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
  // Proposition layer.
  for (const [k,v] of Object.entries(cp.propositions||{}))
    M.propositions.set(k, {...v, docs: new Set(v.docs || [])});
  for (const [k,v] of Object.entries(cp.predicateSlots||{}))
    M.predicateSlots.set(k, {
      ...v,
      verbs: new Map(Object.entries(v.verbs || {})),
      doc_anchors: new Set(v.doc_anchors || []),
    });
  for (const [k,v] of Object.entries(cp.propIntegrals||{}))  M.propIntegrals.set(k, v);
  for (const [k,v] of Object.entries(cp.slotIntegrals||{}))  M.slotIntegrals.set(k, v);
  for (const [k,v] of Object.entries(cp.propDEFFrames||{}))  M.propDEFFrames.set(k, v);
  for (const [k,v] of Object.entries(cp.cultivating||{}))    M.cultivating.set(k, v);
  for (const [k,v] of Object.entries(cp.negated||{}))        M.negated.set(k, v);
  for (const [k,v] of Object.entries(cp.distinctions||{}))   M.distinctions.set(k, new Set(v));
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
    } else if (op === 'focus_sig' || op === 'FOCUS_SIG') {
      // Reading-session focus event from the main thread (spec §6).
      const r = handleFocusSig(payload);
      self.postMessage({ id, result: r });
    } else if (op === 'get_working_set' || op === 'GET_WORKING_SET') {
      const grain = typeof payload?.grain === 'number'
        ? payload.grain
        : grainForBoundary(payload?.grain);
      const theta = COREF_CONFIG.working_set;
      const out = [];
      for (const [a, ent] of M.entities) {
        const iv = (ent.grain_values?.[grain] ?? ent.integral_value ?? 0);
        if (iv >= theta) {
          out.push({
            anchor: a,
            integral_value: iv,
            display_name: M.displayNames.get(a) || a,
            coherence_score: ent.coherence_score,
            last_mention_position: ent.last_mention_position,
          });
        }
      }
      out.sort((x, y) => y.integral_value - x.integral_value);
      self.postMessage({ id, result: { grain, entities: out } });
    } else if (op === 'get_candidate_count' || op === 'GET_CANDIDATE_COUNT') {
      let above = 0;
      const theta = COREF_CONFIG.ins_threshold;
      const cands = M.candidates || new Map();
      for (const c of cands.values()) if ((c.integral_value || 0) >= theta) above++;
      self.postMessage({ id, result: {
        count: cands.size,
        above_ins_threshold: above,
        pending_cons: M.pendingCons.length,
      }});
    } else if (op === 'coref_config') {
      // Read or update thresholds at runtime (settings panel hook).
      if (payload && typeof payload === 'object') {
        for (const k of Object.keys(payload)) {
          if (k === 'decay' && payload.decay) {
            Object.assign(COREF_CONFIG.decay, payload.decay);
          } else if (k === 'focus_strength' && payload.focus_strength) {
            Object.assign(COREF_CONFIG.focus_strength, payload.focus_strength);
          } else if (k in COREF_CONFIG) {
            COREF_CONFIG[k] = payload[k];
          }
        }
      }
      self.postMessage({ id, result: { ...COREF_CONFIG } });
    } else if (op === 'flush') {
      await flushDelta();
      self.postMessage({ id, result: 'flushed' });
    } else if (op === 'get_entity_anchors') {
      // Spec §"Change 1": return INS'd entities filtered by doc_anchor as
      // a {normalized → anchor} map for downstream stages (CON, SYN, EVA)
      // to gate on. Only entities that crossed the integral threshold
      // appear here; pre-INS candidates do not.
      const da = payload?.doc_anchor;
      const out = {};
      for (const [a, ent] of M.entities) {
        if (!ent.ops?.includes('INS')) continue;
        if (da && !ent.docs?.has?.(da)) continue;
        const norm = (ent.normalized || ent.display_name || M.displayNames.get(a) || '')
          .trim().toLowerCase();
        if (!norm) continue;
        if (!out[norm]) out[norm] = a;
      }
      self.postMessage({ id, result: out });
    } else if (op === 'get_candidate_anchors') {
      // Pre-INS candidates with their accumulated integrals — used by
      // stageCON to route co-occurrence as SIG_EVIDENCE rather than CON.
      const out = {};
      const cands = M.candidates || new Map();
      for (const [a, c] of cands) {
        const norm = (c.normalized || '').trim().toLowerCase();
        if (!norm) continue;
        out[norm] = {
          anchor: a,
          integral: c.integral_value || 0,
          sig_count: c.sig_count || 0,
        };
      }
      self.postMessage({ id, result: out });
    } else if (op === 'get_integrals') {
      const da = payload?.doc_anchor;
      const out = {};
      for (const [a, ent] of M.entities) {
        if (da && !ent.docs?.has?.(da)) continue;
        out[a] = ent.integral_value || 0;
      }
      self.postMessage({ id, result: out });
    } else if (op === 'get_all_frames') {
      const da = payload?.doc_anchor;
      const out = {};
      for (const [a, frame] of M.defFrames) {
        if (da && frame.doc_anchor && frame.doc_anchor !== da) continue;
        out[a] = frame;
      }
      self.postMessage({ id, result: out });
    } else if (op === 'crystallize_frames') {
      const r = crystallizeFrames(payload?.doc_anchor);
      self.postMessage({ id, result: r });
    } else if (op === 'crystallize_slots') {
      // Rewrite-plan §3 — per-slot predicate-class DEF crystallization.
      const r = crystallizeSlots(payload?.doc_anchor);
      self.postMessage({ id, result: r });
    } else if (op === 'get_propositions') {
      // Returns all proposition records (INS'd and accumulating).
      const out = {};
      const da = payload?.doc_anchor;
      for (const [k, v] of M.propositions) {
        if (da && !v.docs?.has?.(da)) continue;
        out[k] = { ...v, docs: [...(v.docs || [])], integral: M.propIntegrals.get(k) || 0 };
      }
      self.postMessage({ id, result: out });
    } else if (op === 'get_proposition_graph') {
      // Dual graph: entity nodes + edges partitioned by con_type, plus
      // proposition nodes floating above. Used by the explorer's new
      // proposition-view render path (rewrite-plan §11).
      const entities = {};
      for (const [k, v] of M.entities) entities[k] = { ...v, docs: [...(v.docs || [])] };
      const edgesByType = { binding: {}, tracing: {}, tending_refreshed: {}, clearing: {}, dissecting: {}, legacy: {} };
      for (const [k, v] of M.conEdges) {
        const bucket = v.con_type === CON_TYPES.BINDING       ? 'binding'
                     : v.con_type === CON_TYPES.TRACING       ? 'tracing'
                     : v.con_type === CON_TYPES.TENDING       ? 'tending_refreshed'
                     : v.con_type === CON_TYPES.CLEARING      ? 'clearing'
                     : v.con_type === CON_TYPES.DISSECTING    ? 'dissecting'
                     : 'legacy';
        edgesByType[bucket][k] = v;
      }
      const propositions = {};
      for (const [k, v] of M.propositions) {
        propositions[k] = { ...v, docs: [...(v.docs || [])], integral: M.propIntegrals.get(k) || 0 };
      }
      const slots = {};
      for (const [k, v] of M.predicateSlots) {
        slots[k] = {
          ...v,
          verbs: Object.fromEntries(v.verbs || []),
          doc_anchors: [...(v.doc_anchors || [])],
          integral: M.slotIntegrals.get(k) || 0,
        };
      }
      self.postMessage({ id, result: {
        nodes: entities,
        edges: edgesByType,
        propositions,
        slots,
        negated: Object.fromEntries(M.negated),
        distinctions: Object.fromEntries(
          [...M.distinctions.entries()].map(([k, v]) => [k, [...v]])
        ),
        displayNames: Object.fromEntries(M.displayNames),
      }});
    } else if (op === 'cultivating_gap_for_slot') {
      // Structural NUL for the Cultivating-without-Making pattern (§8):
      // the slot was gestured toward but never instantiated as a
      // Binding CON. Returns { cultivating_count, making_count, state }.
      const slotKey = (payload?.slot || '').trim().toLowerCase();
      const cult = (M.cultivating.get(slotKey) || []).length;
      let making = 0;
      for (const slot of M.predicateSlots.values()) {
        if ((slot.subject || '').toLowerCase().includes(slotKey) ||
            (slot.object  || '').toLowerCase().includes(slotKey)) {
          making += [...(slot.verbs?.values?.() || [])].reduce((a,b)=>a+b, 0);
        }
      }
      const state = making > 0     ? 'instantiated'
                  : cult   > 0     ? 'unknown'
                  :                  'never_set';
      self.postMessage({ id, result: { cultivating_count: cult, making_count: making, state } });
    } else if (op === 'nul_state_for_slot') {
      // Resolve the structural NUL state for a named slot (never_set /
      // unknown / cleared / active) from integral history. Used by main-
      // thread stageNUL to back keyword matches with structural evidence.
      self.postMessage({ id, result: nulStateForSlot(payload?.slot || '') });
    } else {
      self.postMessage({ id, error: 'unknown op: ' + op });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
