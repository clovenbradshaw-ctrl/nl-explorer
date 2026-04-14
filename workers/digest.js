// workers/digest.js
// Pure, deterministic summary composer. Given the in-memory combined log and
// doc set, produce a structured digest that approximates an LLM summary by
// *measurement* instead of *generation* — every bullet links back to the
// log_id it came from, so the summary is auditable.
//
// Loaded as a classic script (not a web worker) because it reads directly
// from the main-thread state.combined / state.docs and the fold-worker
// pressure map proxied through workerBridge.pressure.

(function (root) {
  'use strict';

  const LENGTHS = {
    tldr:     { cast: 3,  arcs: 3,  edgesPerEntity: 2, questions: 3 },
    brief:    { cast: 6,  arcs: 6,  edgesPerEntity: 3, questions: 6 },
    expanded: { cast: 12, arcs: 12, edgesPerEntity: 4, questions: 12 },
  };

  function entriesFor(log, docAnchor) {
    if (!log) return [];
    const all = log.entries();
    if (!docAnchor) return all;
    return all.filter(e =>
      e.provenance?.doc_anchor === docAnchor ||
      (e.target && String(e.target).includes(docAnchor))
    );
  }

  // Best human label we can produce for an entity anchor, preferring the
  // canonical display_name DEF and falling back to truncated anchor.
  function resolveDisplayName(entries, anchorId, fallback) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.op === 'DEF' && e.target === anchorId &&
          e.operand?.param === 'display_name') return e.operand.value;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.op === 'DEF' && e.target === anchorId &&
          e.operand?.param === 'canonical_name') return e.operand.value;
    }
    return fallback || (anchorId ? anchorId.slice(0, 12) : '');
  }

  // Rebuild a lightweight M-like view from the log. We prefer the fold
  // worker's pressure map when available but derive the rest locally so the
  // digest works even when OPFS/workers are disabled.
  function collectEntities(entries, pressureMap) {
    const ents = new Map();  // anchor → {sig_count, docs:Set, is_hub, hub_degree, nul_signals:[], eva_conflicts}
    const edges = new Map(); // `${s}:${o}` → {s,o,predicate,confidence,count,sources:Set,log_ids:[]}
    const evaByTarget = new Map(); // target → EVA[] (embedding classifications)
    const recByTarget = new Map(); // target → REC entries
    const defFrames   = new Map(); // anchor → frame
    const displayNames= new Map();
    const sigByDoc    = new Map(); // anchor → {doc}/count
    const clauseSegs  = new Map(); // seg_anchor → SEG entry (clause-level)
    const clauseByEntity = new Map(); // entity_anchor → Set<seg_anchor>

    // Helper: register a (entity, clause-seg) mention so bestQuoteFor() can
    // pull a representative span for an entity even though EVAs target the
    // clause anchor, not the entity anchor.
    function noteMention(entityAnchor, segAnchorCandidate) {
      if (!entityAnchor || !segAnchorCandidate) return;
      if (!clauseByEntity.has(entityAnchor)) clauseByEntity.set(entityAnchor, new Set());
      clauseByEntity.get(entityAnchor).add(segAnchorCandidate);
    }

    // First pass: index clause SEGs by span so CON/SIG with a provenance
    // span can be mapped back to the clause that contained them.
    const segsBySpanStart = new Map();
    for (const e of entries) {
      if (e.op === 'SEG' && e.operand?.type === 'clause' &&
          e.provenance?.span_start != null) {
        segsBySpanStart.set(e.provenance.span_start, e.anchor);
      }
    }
    function segAtSpan(spanStart, spanEnd) {
      if (spanStart == null) return null;
      if (segsBySpanStart.has(spanStart)) return segsBySpanStart.get(spanStart);
      // Fallback: find the clause whose span contains this one.
      for (const [, seg] of segsBySpanStart) { /* noop */ }
      return null;
    }

    for (const e of entries) {
      if (e.op === 'SEG' && e.operand?.type === 'clause') {
        clauseSegs.set(e.anchor, e);
      }
      if (e.op === 'INS' && e.target === 'entity-registry') {
        const a = e.anchor;
        if (!ents.has(a)) ents.set(a, {
          anchor: a, sig_count: 0, docs: new Set(), nul_signals: [],
          eva_conflicts: 0, log_ids: [],
        });
        ents.get(a).docs.add(e.provenance?.doc_anchor);
        ents.get(a).log_ids.push(e.log_id);
      }
      if (e.op === 'DEF' && e.operand?.param === 'display_name') {
        displayNames.set(e.target, e.operand.value);
      }
      if (e.op === 'DEF' && e.operand?.param === 'frame') {
        defFrames.set(e.target, { ...e.operand, log_id: e.log_id, ts: e.ts });
      }
      if (e.op === 'SIG') {
        const tgt = e.target;
        // Count recurrences toward whoever is the subject/anchor. SIG on
        // entities bumps the sig_count used for ranking.
        if (ents.has(e.anchor)) ents.get(e.anchor).sig_count++;
        if (tgt && ents.has(tgt)) ents.get(tgt).sig_count++;
        // Map this SIG's source clause to the entity.
        const segA = segAtSpan(e.provenance?.span_start, e.provenance?.span_end);
        if (segA) {
          if (ents.has(e.anchor)) noteMention(e.anchor, segA);
          if (ents.has(tgt))      noteMention(tgt, segA);
        }
      }
      if (e.op === 'CON') {
        const s = e.target;
        const o = e.operand?.object_anchor;
        if (!s || !o) continue;
        const segA = segAtSpan(e.provenance?.span_start, e.provenance?.span_end);
        if (segA) { noteMention(s, segA); noteMention(o, segA); }
        const key = `${s}:${o}`;
        const existing = edges.get(key);
        if (existing) {
          existing.count++;
          existing.confidence = Math.min(0.99, existing.confidence + 0.05);
          if (e.provenance?.doc_anchor) existing.sources.add(e.provenance.doc_anchor);
          existing.log_ids.push(e.log_id);
        } else {
          edges.set(key, {
            s, o,
            predicate: e.operand?.verb || e.operand?.relation_type || 'related',
            confidence: e.provenance?.confidence || 0.5,
            count: 1,
            sources: new Set(e.provenance?.doc_anchor ? [e.provenance.doc_anchor] : []),
            log_ids: [e.log_id],
          });
        }
      }
      if (e.op === 'EVA' && e.operand?.eva_type === 'embedding_classification') {
        const tgt = e.target;
        if (!evaByTarget.has(tgt)) evaByTarget.set(tgt, []);
        evaByTarget.get(tgt).push(e);
        if (e.operand?.agreement === false && ents.has(tgt)) {
          ents.get(tgt).eva_conflicts++;
        }
      }
      if (e.op === 'REC') {
        const tgt = e.target;
        if (!recByTarget.has(tgt)) recByTarget.set(tgt, []);
        recByTarget.get(tgt).push(e);
      }
      if (e.op === 'NUL') {
        const tgt = e.target;
        if (ents.has(tgt)) {
          ents.get(tgt).nul_signals.push({
            signal: e.operand?.signal, absence_type: e.operand?.absence_type,
            log_id: e.log_id,
          });
        }
      }
      if (e.op === 'SYN') {
        const hub = e.operand?.hub_anchor;
        if (hub && ents.has(hub)) {
          ents.get(hub).is_hub = true;
          ents.get(hub).hub_degree = e.operand?.hub_degree || 0;
        }
      }
    }

    // Apply live pressure (from the fold worker) onto entities.
    if (pressureMap) {
      for (const [a, p] of Object.entries(pressureMap)) {
        if (ents.has(a)) ents.get(a).pressure = p;
      }
    }
    return { ents, edges, evaByTarget, recByTarget, defFrames, displayNames,
             clauseSegs, clauseByEntity };
  }

  function rankEntities(ents) {
    const list = [...ents.values()].map(ent => {
      const sig = ent.sig_count || 0;
      const hub = ent.hub_degree || 0;
      const z   = ent.pressure?.z || 0;
      // Weighted composite: SIG frequency is the primary signal, hub degree
      // is amplification, pressure is z-scored salience (contested/anomalous).
      const rank = 0.6 * sig + 0.25 * hub + 0.15 * Math.max(z, 0);
      return { ...ent, rank };
    });
    list.sort((a, b) => b.rank - a.rank);
    return list;
  }

  // Histogram of EVA cell classifications — this is the "shape" of the
  // document and stands in for the theme/topic part of an LLM summary.
  function cellHistogram(evaByTarget) {
    const hist = {};
    const modes = { Differentiating: 0, Relating: 0, Generating: 0 };
    const domains = { Existence: 0, Structure: 0, Significance: 0 };
    let total = 0;
    for (const evas of evaByTarget.values()) {
      for (const e of evas) {
        const cid = e.operand?.cell_id;
        if (!cid) continue;
        hist[cid] = (hist[cid] || 0) + 1;
        total++;
        if (e.operand?.mode)   modes[e.operand.mode]     = (modes[e.operand.mode]   || 0) + 1;
        if (e.operand?.domain) domains[e.operand.domain] = (domains[e.operand.domain]|| 0) + 1;
      }
    }
    const topCells = Object.entries(hist)
      .sort((a, b) => b[1] - a[1])
      .map(([cell_id, n]) => ({ cell_id, n, pct: total ? n / total : 0 }));
    const dominantMode   = Object.entries(modes  ).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    const dominantDomain = Object.entries(domains).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    return { hist, total, topCells, dominantMode, dominantDomain, modes, domains };
  }

  function bestQuoteFor(anchorId, evaByTarget, clauseSegs, rawText, clauseByEntity) {
    // Pull EVAs either directly targeting this anchor (rare for entities)
    // or targeting any clause SEG where this entity was mentioned.
    const direct = evaByTarget.get(anchorId) || [];
    const mentionSegs = clauseByEntity ? (clauseByEntity.get(anchorId) || new Set()) : new Set();
    const viaMentions = [];
    for (const segA of mentionSegs) {
      const segEvas = evaByTarget.get(segA);
      if (segEvas) viaMentions.push(...segEvas);
    }
    const evas = direct.concat(viaMentions);
    if (!evas.length || !rawText) return null;
    // Prefer the highest-confidence non-boundary classification targeting
    // this entity. Fall back to any EVA with a span.
    const ranked = evas.slice().sort((a, b) => {
      const ca = a.provenance?.confidence || 0;
      const cb = b.provenance?.confidence || 0;
      return cb - ca;
    });
    for (const e of ranked) {
      let start = e.provenance?.span_start;
      let end   = e.provenance?.span_end;
      if ((start == null || end == null) && e.anchor) {
        const seg = clauseSegs.get(e.anchor);
        start = seg?.provenance?.span_start;
        end   = seg?.provenance?.span_end;
      }
      if (start != null && end != null && end > start && end <= rawText.length) {
        return {
          text: rawText.slice(start, end).trim(),
          span_start: start, span_end: end,
          log_id: e.log_id,
          confidence: e.provenance?.confidence,
          cell_id: e.operand?.cell_id,
        };
      }
    }
    return null;
  }

  function composeCast(ranked, K, displayNames, defFrames, edges, evaByTarget, clauseSegs, rawText, edgesPerEntity, clauseByEntity) {
    const cast = [];
    for (const ent of ranked.slice(0, K)) {
      const a = ent.anchor;
      const name = displayNames.get(a) || resolveDisplayName([], a, a.slice(0, 12));
      const frame = defFrames.get(a);
      const outgoing = [];
      const incoming = [];
      for (const edge of edges.values()) {
        if (edge.s === a) outgoing.push(edge);
        if (edge.o === a) incoming.push(edge);
      }
      outgoing.sort((x, y) => y.confidence - x.confidence);
      incoming.sort((x, y) => y.confidence - x.confidence);
      const pickedOut = outgoing.slice(0, edgesPerEntity).map(edge => ({
        predicate: edge.predicate,
        object_anchor: edge.o,
        object_name: displayNames.get(edge.o) || edge.o.slice(0, 12),
        confidence: edge.confidence,
        count: edge.count,
        log_ids: edge.log_ids.slice(0, 3),
      }));
      cast.push({
        anchor: a,
        display_name: name,
        rank: ent.rank,
        sig_count: ent.sig_count,
        hub_degree: ent.hub_degree || 0,
        pressure_z: ent.pressure?.z ?? null,
        frame: frame ? {
          value: frame.value,
          is_hub: !!frame.is_hub,
          log_id: frame.log_id,
        } : null,
        edges: pickedOut,
        quote: bestQuoteFor(a, evaByTarget, clauseSegs, rawText, clauseByEntity),
        nul_signals: (ent.nul_signals || []).slice(0, 3),
        eva_conflicts: ent.eva_conflicts || 0,
        log_ids: (ent.log_ids || []).slice(0, 2),
      });
    }
    return cast;
  }

  // Story "arcs" — highest-confidence SPO triples that span distinct
  // subjects, which gives the reader a compressed throughline.
  function composeArcs(edges, displayNames, K) {
    const sorted = [...edges.values()].sort((a, b) => b.confidence - a.confidence);
    const arcs = [];
    const seenSubjects = new Set();
    for (const edge of sorted) {
      if (arcs.length >= K) break;
      if (seenSubjects.has(edge.s) && arcs.length >= K / 2) continue;
      arcs.push({
        s: edge.s,
        p: edge.predicate,
        o: edge.o,
        s_name: displayNames.get(edge.s) || edge.s.slice(0, 12),
        o_name: displayNames.get(edge.o) || edge.o.slice(0, 12),
        confidence: edge.confidence,
        count: edge.count,
        log_ids: edge.log_ids.slice(0, 3),
      });
      seenSubjects.add(edge.s);
    }
    return arcs;
  }

  function composeOpenQuestions(entries, evaByTarget, recByTarget, displayNames, K) {
    const out = [];
    // REC entries — human review requested
    for (const [tgt, recs] of recByTarget) {
      for (const r of recs) {
        out.push({
          kind: 'rec',
          anchor: tgt,
          target_name: displayNames.get(tgt) || tgt.slice(0, 12),
          note: r.operand?.note || r.operand?.trigger || 'pending review',
          log_id: r.log_id,
        });
      }
    }
    // Contested interpretations — EVAs where mechanical disagrees with geometry
    for (const [tgt, evas] of evaByTarget) {
      const contested = evas.filter(e => e.operand?.agreement === false);
      if (!contested.length) continue;
      out.push({
        kind: 'contested',
        anchor: tgt,
        target_name: displayNames.get(tgt) || tgt.slice(0, 12),
        note: `${contested.length} clause(s) with mechanical/embedding conflict`,
        log_ids: contested.slice(0, 3).map(e => e.log_id),
      });
    }
    // NUL — notable absences
    const nulEntries = entries.filter(e => e.op === 'NUL');
    const nulByAnchor = new Map();
    for (const n of nulEntries) {
      const tgt = n.target || n.anchor;
      if (!nulByAnchor.has(tgt)) nulByAnchor.set(tgt, []);
      nulByAnchor.get(tgt).push(n);
    }
    for (const [tgt, ns] of nulByAnchor) {
      const signals = ns.map(n => n.operand?.signal || n.operand?.absence_type).filter(Boolean);
      if (!signals.length) continue;
      out.push({
        kind: 'absence',
        anchor: tgt,
        target_name: displayNames.get(tgt) || (typeof tgt === 'string' ? tgt.slice(0, 12) : '?'),
        note: `notable absence: ${signals.slice(0, 3).join(', ')}`,
        log_ids: ns.slice(0, 3).map(n => n.log_id),
      });
    }
    return out.slice(0, K);
  }

  function composeGist(cast, histo, docTitle, clauseCount) {
    if (!cast.length) {
      return {
        line: docTitle
          ? `${docTitle} — ${clauseCount} clause${clauseCount === 1 ? '' : 's'} classified, no entities surfaced yet.`
          : 'No entities surfaced yet.',
        actors: [],
      };
    }
    const names = cast.slice(0, 3).map(c => c.display_name);
    const dom = histo.dominantDomain ? `${histo.dominantDomain}-heavy` : 'Mixed';
    const andJoin = names.length === 1 ? names[0]
                 : names.length === 2 ? `${names[0]} and ${names[1]}`
                 : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    const title = docTitle ? `${docTitle}: ` : '';
    return {
      line: `${title}${dom} document about ${andJoin}.`,
      actors: names,
      mode: histo.dominantMode,
      domain: histo.dominantDomain,
    };
  }

  function composeDigest(opts) {
    const {
      combinedLog,           // OperatorLog (required)
      docs = [],             // [{title, text, log, doc_anchor}]
      docAnchor = null,      // optional — scope digest to a single doc
      pressure = null,       // optional — from fold worker
      length = 'brief',      // 'tldr' | 'brief' | 'expanded'
    } = opts || {};

    const L = LENGTHS[length] || LENGTHS.brief;
    const entries = entriesFor(combinedLog, docAnchor);
    const doc = docAnchor
      ? docs.find(d => d.doc_anchor === docAnchor)
      : docs[docs.length - 1] || null;
    const docTitle = doc?.title || null;
    const rawText  = doc?.text  || null;

    const view = collectEntities(entries, pressure);
    const ranked = rankEntities(view.ents);
    const histo  = cellHistogram(view.evaByTarget);
    const clauseCount = entries.filter(e => e.op === 'SEG' && e.operand?.type === 'clause').length;

    const cast = composeCast(ranked, L.cast, view.displayNames, view.defFrames,
                             view.edges, view.evaByTarget, view.clauseSegs,
                             rawText, L.edgesPerEntity, view.clauseByEntity);
    const arcs = composeArcs(view.edges, view.displayNames, L.arcs);
    const openQuestions = composeOpenQuestions(entries, view.evaByTarget,
                                               view.recByTarget, view.displayNames,
                                               L.questions);
    const gist = composeGist(cast, histo, docTitle, clauseCount);

    return {
      length,
      doc_anchor: docAnchor,
      doc_title: docTitle,
      clause_count: clauseCount,
      entity_count: view.ents.size,
      edge_count: view.edges.size,
      gist,
      theme: histo,
      cast,
      arcs,
      open_questions: openQuestions,
      // Traceability metadata — every rendered bullet can carry a log_id so
      // clicking it jumps straight to the evidence in the log.
      generated_at: new Date().toISOString(),
    };
  }

  root.EODigest = { composeDigest };
})(typeof window !== 'undefined' ? window : globalThis);
