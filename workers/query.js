// workers/query.js
// Naturalistic query layer. Routes a free-text question through:
//   1) entity mention match against display_name DEFs (fuzzy, case-insensitive)
//   2) predicate cue match against CON verbs
//   3) question-type classification (what-is / who / how / why / contested / missing / open)
//   4) cell-affinity: cosine(query_vec, 27 centroids) picks dominant cells
//   5) retrieval plan that combines the signals above, with semantic rerank
//
// Every returned clause carries its log_id + span offsets — the query
// answer is retrieval, not generation.
//
// Loaded as a classic script; depends on window.EOClassifier (embedText,
// centroids) and window.EODigest (for the shared cast/edge assembler).

(function (root) {
  'use strict';

  // ── Text utilities ──────────────────────────────────────────────

  function tokenize(text) {
    return (text || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  const STOP = new Set([
    'the','a','an','and','or','but','of','to','in','on','for','with','by',
    'is','are','was','were','be','been','being','has','have','had','do','does',
    'did','will','would','can','could','should','may','might','must','shall',
    'this','that','these','those','i','you','he','she','it','we','they','them',
    'his','her','its','their','our','your','my','what','which','who','whom',
    'whose','when','where','why','how','about','if','than','then','there',
  ]);

  function contentTokens(text) {
    return tokenize(text).filter(t => !STOP.has(t));
  }

  // Match query tokens to display_name values. Returns ranked anchors.
  function matchEntitiesByName(queryText, displayNames) {
    const qTokens = contentTokens(queryText);
    if (!qTokens.length) return [];
    const qStr = queryText.toLowerCase();
    const matches = [];
    for (const [anchor, name] of displayNames) {
      if (!name) continue;
      const nameL = name.toLowerCase();
      const nameTokens = contentTokens(name);
      // exact substring match gets the highest score
      let score = 0;
      if (qStr.includes(nameL)) score += 3;
      let overlap = 0;
      for (const t of nameTokens) if (qTokens.includes(t)) overlap++;
      if (nameTokens.length) score += overlap / nameTokens.length;
      if (score > 0) matches.push({ anchor, name, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  // ── Question-type classifier ────────────────────────────────────

  const QUESTION_PATTERNS = [
    { type: 'what-is',     re: /\b(what|who)\s+is\b|\b(what|who)\s+are\b|\bdefine\b/i },
    { type: 'does-say',    re: /\bsays?\b|\bsaid\b|\bstate[sd]?\b|\bclaim(ed|s)?\b/i },
    { type: 'does-do',     re: /\bdoes\b|\bdo\b|\bdid\b.*\bdo\b|\bwhat.*about\b/i },
    { type: 'relate',      re: /\brelate[sd]?\b|\brelation(ship)?\b|\bconnect(ed|ion)?\b|\bhow.*(related|connected)\b/i },
    { type: 'contested',   re: /\bcontest(ed|ing)?\b|\bdispute[sd]?\b|\buncertain\b|\bconflict(ed|ing|s)?\b|\bdisagree/i },
    { type: 'missing',     re: /\bmissing\b|\babsent\b|\bnot\s+mention(ed)?\b|\bquiet\b|\bleft out\b/i },
    { type: 'document',    re: /\b(this\s+document|what.*about|summar[iy]e)\b/i },
    { type: 'when',        re: /\bwhen\b/i },
    { type: 'where',       re: /\bwhere\b/i },
    { type: 'why',         re: /\bwhy\b/i },
    { type: 'how',         re: /\bhow\b/i },
  ];

  function classifyQuestion(text) {
    for (const p of QUESTION_PATTERNS) {
      if (p.re.test(text)) return p.type;
    }
    return 'open';
  }

  // ── Cell affinity via centroid cosine ───────────────────────────

  async function cellAffinity(queryText) {
    if (!root.EOClassifier || !root.EOClassifier.isReady?.()) return null;
    const centroids = root.EOClassifier.centroids?.();
    if (!centroids?.length) return null;
    const qv = await root.EOClassifier.embedText(queryText, 'latin');
    const cos = root.EOClassifier.cosine;
    const scored = centroids.map(c => ({
      cell_id: c.cell_id, operator: c.operator,
      mode: c.mode, domain: c.domain,
      score: cos(qv, c.vector),
    })).sort((a, b) => b.score - a.score);
    return { vector: qv, scores: scored };
  }

  // ── Corpus views (same shape the digest builds) ─────────────────

  function collectCorpusView(entries) {
    const displayNames = new Map();
    const defFrames    = new Map();
    const evaByTarget  = new Map();
    const recByTarget  = new Map();
    const clauseSegs   = new Map();
    const edges        = new Map();
    const conBySubject = new Map();
    const conByObject  = new Map();
    const nulByTarget  = new Map();

    for (const e of entries) {
      if (e.op === 'SEG' && e.operand?.type === 'clause') clauseSegs.set(e.anchor, e);
      if (e.op === 'DEF' && e.operand?.param === 'display_name') displayNames.set(e.target, e.operand.value);
      if (e.op === 'DEF' && e.operand?.param === 'frame')        defFrames.set(e.target, e);
      if (e.op === 'EVA' && e.operand?.eva_type === 'embedding_classification') {
        if (!evaByTarget.has(e.target)) evaByTarget.set(e.target, []);
        evaByTarget.get(e.target).push(e);
      }
      if (e.op === 'REC') {
        if (!recByTarget.has(e.target)) recByTarget.set(e.target, []);
        recByTarget.get(e.target).push(e);
      }
      if (e.op === 'NUL') {
        const tgt = e.target;
        if (!nulByTarget.has(tgt)) nulByTarget.set(tgt, []);
        nulByTarget.get(tgt).push(e);
      }
      if (e.op === 'CON') {
        const s = e.target, o = e.operand?.object_anchor;
        if (!s || !o) continue;
        const key = `${s}:${o}`;
        if (!edges.has(key)) {
          edges.set(key, {
            s, o,
            predicate: e.operand?.verb || e.operand?.relation_type || 'related',
            confidence: e.provenance?.confidence || 0.5,
            count: 1,
            log_ids: [e.log_id],
          });
        } else {
          const ex = edges.get(key);
          ex.count++;
          ex.confidence = Math.min(0.99, ex.confidence + 0.05);
          ex.log_ids.push(e.log_id);
        }
        if (!conBySubject.has(s)) conBySubject.set(s, []);
        conBySubject.get(s).push(e);
        if (!conByObject.has(o)) conByObject.set(o, []);
        conByObject.get(o).push(e);
      }
    }
    return { displayNames, defFrames, evaByTarget, recByTarget, clauseSegs,
             edges, conBySubject, conByObject, nulByTarget };
  }

  // ── Clause span lookup ──────────────────────────────────────────

  function spanFor(evaEntry, view, docsByAnchor) {
    let start = evaEntry.provenance?.span_start;
    let end   = evaEntry.provenance?.span_end;
    if ((start == null || end == null) && evaEntry.anchor) {
      const seg = view.clauseSegs.get(evaEntry.anchor);
      start = seg?.provenance?.span_start;
      end   = seg?.provenance?.span_end;
    }
    const docAnchor = evaEntry.provenance?.doc_anchor;
    const doc = docAnchor ? docsByAnchor.get(docAnchor) : null;
    if (start != null && end != null && doc?.text && end <= doc.text.length) {
      return {
        text: doc.text.slice(start, end).trim(),
        span_start: start, span_end: end, doc_anchor: docAnchor,
        doc_title: doc.title || null,
      };
    }
    return null;
  }

  // Rerank candidate EVAs by overlap with query tokens + cell alignment with
  // the query's top centroids. Cheap substitute for full semantic rerank;
  // it still exploits the 27-cell ontology as a soft topic filter.
  function rerankClauses(evas, queryTokens, topCellIds, view, docsByAnchor, limit) {
    const qSet = new Set(queryTokens);
    const cellSet = new Set(topCellIds);
    const scored = [];
    for (const e of evas) {
      const sp = spanFor(e, view, docsByAnchor);
      if (!sp) continue;
      const toks = contentTokens(sp.text);
      let overlap = 0;
      for (const t of toks) if (qSet.has(t)) overlap++;
      const tokScore  = toks.length ? overlap / Math.sqrt(toks.length) : 0;
      const cellScore = cellSet.has(e.operand?.cell_id) ? 1 : 0;
      const confScore = e.provenance?.confidence || 0.5;
      const rank = 1.2 * tokScore + 0.6 * cellScore + 0.4 * confScore;
      scored.push({
        log_id: e.log_id,
        cell_id: e.operand?.cell_id,
        confidence: confScore,
        agreement: e.operand?.agreement,
        notation: e.operand?.notation,
        span: sp,
        target: e.target,
        score: rank,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ── Path search over CON edges (for "how is X related to Y?") ───

  function findPaths(edges, from, to, maxDepth) {
    const adj = new Map();
    for (const edge of edges.values()) {
      if (!adj.has(edge.s)) adj.set(edge.s, []);
      adj.get(edge.s).push(edge);
      if (!adj.has(edge.o)) adj.set(edge.o, []);
      // Undirected for path-search purposes; predicate direction preserved.
      adj.get(edge.o).push({ ...edge, _reverse: true });
    }
    const paths = [];
    const queue = [{ node: from, path: [] }];
    const seen = new Set([from]);
    while (queue.length) {
      const { node, path } = queue.shift();
      if (path.length > maxDepth) continue;
      const next = adj.get(node) || [];
      for (const edge of next) {
        const neighbor = edge._reverse ? edge.s : edge.o;
        if (seen.has(neighbor) && neighbor !== to) continue;
        const newPath = path.concat([edge]);
        if (neighbor === to) { paths.push(newPath); continue; }
        seen.add(neighbor);
        queue.push({ node: neighbor, path: newPath });
      }
    }
    return paths.slice(0, 5);
  }

  // ── The planner / retriever ─────────────────────────────────────

  async function answerQuery(opts) {
    const {
      queryText,
      combinedLog,
      docs = [],
      docAnchor = null,
      limit = 8,
    } = opts || {};

    if (!queryText || !combinedLog) {
      return { error: 'Missing queryText or combinedLog' };
    }

    const all = combinedLog.entries();
    const entries = docAnchor
      ? all.filter(e => e.provenance?.doc_anchor === docAnchor)
      : all;
    const docsByAnchor = new Map(docs.filter(d => d.doc_anchor).map(d => [d.doc_anchor, d]));
    const view = collectCorpusView(entries);

    const qType = classifyQuestion(queryText);
    const qTokens = contentTokens(queryText);
    const entityMatches = matchEntitiesByName(queryText, view.displayNames);
    const cells = await cellAffinity(queryText);
    const topCellIds = cells ? cells.scores.slice(0, 3).map(c => c.cell_id) : [];

    // Gather candidate EVA entries based on the retrieval strategy.
    let candidates = [];
    const trace = { question_type: qType, entities: entityMatches.slice(0, 5), top_cells: topCellIds,
                    steps: [] };

    // 1) Entity-scoped retrieval
    const focusAnchors = entityMatches.slice(0, 3).map(m => m.anchor);
    if (focusAnchors.length) {
      trace.steps.push({ step: 'entity_focus', anchors: focusAnchors });
      for (const a of focusAnchors) {
        const evas = view.evaByTarget.get(a) || [];
        candidates.push(...evas);
        // Also consider EVAs whose clause mentions this subject via CON
        const con = view.conBySubject.get(a) || [];
        for (const c of con) {
          const segForCon = view.clauseSegs.get(c.anchor);
          if (segForCon) {
            const segEvas = view.evaByTarget.get(c.anchor) || [];
            candidates.push(...segEvas);
          }
        }
      }
    }

    // 2) Cell-guided retrieval if candidates are thin or question is open
    if (candidates.length < limit * 2 || qType === 'open') {
      trace.steps.push({ step: 'cell_scan', cells: topCellIds });
      for (const evas of view.evaByTarget.values()) {
        for (const e of evas) {
          if (topCellIds.includes(e.operand?.cell_id)) candidates.push(e);
        }
      }
    }

    // De-dupe
    const seen = new Set();
    candidates = candidates.filter(e => {
      if (seen.has(e.log_id)) return false;
      seen.add(e.log_id); return true;
    });

    // Special-case assemblies that don't need a reranked clause list
    const answer = { type: qType, bullets: [] };

    if (qType === 'what-is' && focusAnchors.length) {
      for (const a of focusAnchors) {
        const frame = view.defFrames.get(a);
        const name = view.displayNames.get(a) || a.slice(0, 12);
        const sigs = entries.filter(e => e.op === 'SIG' && (e.target === a || e.anchor === a)).slice(0, 3);
        answer.bullets.push({
          kind: 'definition',
          subject: name, anchor: a,
          frame: frame?.operand?.value || null,
          frame_log_id: frame?.log_id || null,
          sig_log_ids: sigs.map(s => s.log_id),
          edges_out: (view.conBySubject.get(a) || []).slice(0, 3).map(c => ({
            predicate: c.operand?.verb || c.operand?.relation_type || 'related',
            object: view.displayNames.get(c.operand?.object_anchor) || c.operand?.object_anchor,
            log_id: c.log_id,
          })),
        });
      }
    } else if (qType === 'relate' && entityMatches.length >= 2) {
      const a = entityMatches[0].anchor;
      const b = entityMatches[1].anchor;
      const paths = findPaths(view.edges, a, b, 3);
      trace.steps.push({ step: 'path_search', from: a, to: b, found: paths.length });
      for (const path of paths) {
        answer.bullets.push({
          kind: 'path',
          from: view.displayNames.get(a) || a,
          to: view.displayNames.get(b) || b,
          hops: path.map(e => ({
            predicate: e.predicate, confidence: e.confidence,
            s: view.displayNames.get(e.s) || e.s,
            o: view.displayNames.get(e.o) || e.o,
            log_ids: e.log_ids.slice(0, 2),
          })),
        });
      }
    } else if (qType === 'contested') {
      // Contested = mechanical/embedding conflict OR REC pending
      for (const [tgt, evas] of view.evaByTarget) {
        const conflicts = evas.filter(e => e.operand?.agreement === false);
        if (!conflicts.length) continue;
        answer.bullets.push({
          kind: 'contested',
          subject: view.displayNames.get(tgt) || tgt.slice(0, 12),
          anchor: tgt,
          count: conflicts.length,
          log_ids: conflicts.slice(0, 3).map(e => e.log_id),
        });
      }
      for (const [tgt, recs] of view.recByTarget) {
        for (const r of recs) {
          answer.bullets.push({
            kind: 'rec',
            subject: view.displayNames.get(tgt) || tgt.slice(0, 12),
            anchor: tgt,
            note: r.operand?.note || r.operand?.trigger,
            log_id: r.log_id,
          });
        }
      }
    } else if (qType === 'missing') {
      for (const [tgt, ns] of view.nulByTarget) {
        const signals = ns.map(n => n.operand?.signal || n.operand?.absence_type).filter(Boolean);
        if (!signals.length) continue;
        answer.bullets.push({
          kind: 'absence',
          subject: view.displayNames.get(tgt) || (typeof tgt === 'string' ? tgt.slice(0, 12) : '?'),
          anchor: tgt,
          signals: signals.slice(0, 3),
          log_ids: ns.slice(0, 3).map(n => n.log_id),
        });
      }
    } else if (qType === 'document' && root.EODigest) {
      trace.steps.push({ step: 'delegate_to_digest' });
      const d = root.EODigest.composeDigest({
        combinedLog, docs, docAnchor, length: 'brief',
        pressure: opts.pressure || null,
      });
      answer.bullets.push({ kind: 'digest', digest: d });
    }

    // Always provide supporting clauses — ranked spans with citations.
    const supporting = rerankClauses(candidates, qTokens, topCellIds, view, docsByAnchor, limit);

    return {
      query: queryText,
      doc_anchor: docAnchor,
      plan: trace,
      answer,
      supporting,
      cell_affinity: cells ? cells.scores.slice(0, 5) : [],
      generated_at: new Date().toISOString(),
    };
  }

  root.EOQuery = { answerQuery, classifyQuestion, tokenize, contentTokens };
})(typeof window !== 'undefined' ? window : globalThis);
