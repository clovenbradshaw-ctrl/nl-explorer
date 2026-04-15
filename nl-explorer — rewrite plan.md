# nl-explorer — rewrite plan
# Grounded in OstromPolyGov log composition, April 2026.
# Three layers: fix the rendering boundary first (immediate), reduce
# source junk second (this week), make the learning loop visible third.

---

## Root cause

Two independent failures compound each other.

**Failure A — dual INS paths**

`stageINS_threshold` (index.html:2855) fires INS when a cluster's
member count crosses `max(3, mean + 1.0·sd)`. This runs in the main
thread, synchronously, before the fold worker runs. It has no integral
dynamics — it sees one number. `workers/fold-worker.js:390-413`
maintains a proper running integral but never runs first. Result: 382
entities instantiated via count alone, including citation strings,
figure-label runs, and abstract nouns that appeared three times.

**Failure B — raw output shown with no quality gate**

The UI renders everything the pipeline emits. 13,250 SIG entries,
7,638 predicate-less CON edges, 382 low-quality entities, 978 mostly-
flat EVA profiles — all simultaneously. The screenshot is not a UX
problem. It is a data quality problem rendered honestly.

The right response is two-tracked: fix the rendering boundary
immediately (so the UI is usable today), and fix the source
simultaneously (so the log stops producing junk).

---

## What the log showed

30,561 entries. One document.

```
SIG:  13,250  NP mentions (11,586) + accumulation (1,180) + pronouns (484)
CON:   7,638  co-occurrence (6,962, verb:null) + coref (484, conf:0) + spo (192, verb:"?")
SEG:   6,986  sentence (6,008) + clause (978)
DEF:   1,316  display_name (382) + frequency (382) + frame (292) + surface_form (260)
EVA:     978  embedding_classification; 92% confidence_gap < 0.08
INS:     384  382 via count threshold (bad) + 2 ingest anchors (good)
NUL:       8  explicit_claim keyword only
SYN:       2  topology
```

Confirmed pathologies:

- All 484 pronoun SIG entries: `surface_form: undefined`, `confidence: 0`.
  The extractor writes `text` but the coref system reads `surface_form`.
- All 192 SPO entries: `verb: "?"`. `findVerbBetween` locates NP
  positions using normalized (lowercased) forms against original-case
  text, so the positions are wrong and no verb is found.
- All 484 coreference CON entries: `subject_text: "?"`, `object_text: "?"`,
  `confidence: 0` — consequence of the above.
- DEF frame `value` fields are anchor hashes (`@c150cf84d2f8a376`), not
  text. The inspector displays the hash.
- EVA `boundary` flag on 900 of 978 clauses. Centroids built from
  investigative prose; academic theoretical prose lives elsewhere.
- PDF text fragmented: "J un E 2010", "s elf-organized". `parsePDF`
  joins items with `.join(' ')`, ignoring positional metadata.
- Corpus header hardcoded: "nashville-surveillance-beat · 4 docs · 28
  spans" (index.html:7343).
- Fold-worker DEF/EVA/REC/INS events are silent — no visible ticker.

---

## Layer 1 — Quality filters at the rendering boundary

Do these first. They touch only the rendering path; the log is
untouched. Toggling any filter off requires one predicate change.

### 1.1 `isDisplayableEntity` — single gating predicate

Add near `toDisplayName` (index.html:2561). Wire into: the span rail
populator, `buildAnnotatedHTML`, the Library list (`#tab-lib`), and
the corpus header counter. An entity is hidden from all UI surfaces
if its display name matches any of:

- token count > 5
- contains email (`/\S+@\S+\.\S+/`)
- contains DOI (`/10\.\d{4,}\//i`)
- contains page/figure reference (`/\b(?:fig|figure|table|p|pp|§)\.?\s*\d+/i`)
- contains URL (`/https?:\/\//i`)
- length > 60 chars
- all tokens in `STOP` or gerund list (`['using','understanding','well','studies','article']`)

```javascript
function isDisplayableEntity(anchorOrName) {
  const name = typeof anchorOrName === 'string' && anchorOrName.startsWith('@')
    ? resolveDisplayName(anchorOrName)
    : anchorOrName;
  if (!name) return false;
  const tokens = name.trim().split(/\s+/);
  if (tokens.length > 5 || name.length > 60) return false;
  if (/\S+@\S+\.\S+/.test(name)) return false;
  if (/10\.\d{4,}\//.test(name)) return false;
  if (/\b(?:fig|figure|table|p|pp|§)\.?\s*\d+/i.test(name)) return false;
  if (/https?:\/\//.test(name)) return false;
  const GERUNDS = new Set(['using','understanding','well','studies','article']);
  if (tokens.every(t => STOP.has(t.toLowerCase()) || GERUNDS.has(t.toLowerCase()))) return false;
  return true;
}
```

### 1.2 `hasPredicate` — predicate-required graph

```javascript
function hasPredicate(con) {
  const rel = con.operand?.relation_type;
  return !!(con.operand?.verb || con.operand?.predicate ||
            (rel && rel !== 'co-occurrence'));
}
```

Change the graph renderer (`#gsvg`) to only include edges where
`hasPredicate(con)` is true. If zero edges survive, render:

```
No directed relationships yet.
Co-occurrence is the precondition for a relationship, not one.
Enable predicate extraction (H1 hook) to populate this graph.
```

Update `#gcnt` to the filtered count.

### 1.3 EVA confidence notice strip

At the top of the doc viewer, render a dismissible strip when
flat-rate ≥ 50% (confidence_gap < 0.08). Counts derived live from
`state.combined.byOp('EVA')`:

```
Cell classification confidence is low for this corpus.
900 of 978 clauses below confidence threshold (gap < 0.08).
Current centroids don't discriminate this domain.
[Run H3 tiebreak pass]  [Dismiss]
```

H3 button shows "not yet implemented" tooltip if the hook is absent.
Strip auto-dismisses when flat-rate drops below 30% after a centroid
update.

### 1.4 Dormant highlights on the doc surface

In `buildAnnotatedHTML` (index.html:4654): keep `.anno` markup but
strip background fills from the default CSS. Highlights activate only
on hover:

```css
.anno { border-radius: 2px; padding: 0 1px; }
.anno-ins { background: transparent; border-bottom: 1.5px solid rgba(78,143,98,.3); }
/* all operator backgrounds: transparent by default */
.anno-focus, .anno:hover { background: rgba(196,129,58,.18) !important; }
```

`.anno` wrappers are already restricted by 1.1 (only displayable
entities get wrapped). Prose reads clean by default; annotations are
on-demand.

### 1.5 Ranked entity rail

Replace the flat SIG list in `#rail-list` with a ranked list of
displayable INS entities, sorted by interestingness:

```javascript
function entityScore(anchor) {
  const entries = state.combined.entries().filter(e => e.target === anchor);
  const z = state.combined.entries()
    .find(e => e.op === 'DEF' && e.target === anchor &&
               e.operand?.param === 'frequency')?.operand?.value || 1;
  const hasDEF     = entries.some(e => e.op === 'DEF' && e.operand?.param === 'frame')  ? 0.5 : 0;
  const hasConflict= entries.some(e => e.op === 'EVA' && e.operand?.result === 'conflicts') ? 0.8 : 0;
  const hasREC     = entries.some(e => e.op === 'REC')                                  ? 1.0 : 0;
  const tooLong    = (resolveDisplayName(anchor)?.split(' ').length || 0) > 3           ? -0.3 : 0;
  return (z || 0) + hasDEF + hasConflict + hasREC + tooLong;
}
```

Each row: display name · count × σz · operator sparkline (INS DEF CON
EVA REC dots, dim if absent). Rail header: "N entities", not "K spans".

### 1.6 Click → entity profile card

Rebind `.anno` click handler (`wireDocViewerClicks`, index.html:5365)
to resolve span → entity anchor → call `rInspector(anchor)`
(index.html:6741). Replace the current `rCtxStrip` provenance ladder
(index.html:7732) with an entity profile card:

- display name + type + confidence
- DEF block: first `frame_label` (from 2.8), then up to 3 surface forms
- doc coverage: "appears in 2/4 docs"
- operator badges with counts: `DEF 4 · EVA 2 · REC 1`
- top-3 related entities from `conEdges` (predicate-filtered via 1.2)
- collapsed disclosure: "show raw events" → existing `rCtxStrip`

### 1.7 Grain indicator strip

Add above the doc viewer: `reading at: sentence ▾` with a dropdown
(token / clause / sentence / paragraph / section / document). Wire to
`setRenderGrain / currentGrain` (index.html:5349–5485). Mirror in
Library/Events tab headers.

### 1.8 Dynamic corpus header

Replace hardcoded string (index.html:7343):

```javascript
function renderCorpusHeader() {
  const docCount = state.docs.length;
  const entityCount = state.combined?.entries()
    .filter(e => e.op === 'INS' && e.target === 'entity-registry')
    .filter(e => isDisplayableEntity(e.anchor))
    .length || 0;
  const title = state.docs[0]?.title || 'untitled';
  return `corpus: ${title} · ${docCount} doc${docCount !== 1 ? 's' : ''} · ${entityCount} entities`;
}
```

---

## Layer 2 — Reduce junk at the source

### 2.1 Position-aware PDF join (parsePDF, index.html:5824)

Replace `items.map(str).join(' ')` with a positional reconstructor.
Group `pdf.js` items by `item.transform[5]` (y) within ± half font
height. Sort each line by `item.transform[4]` (x). Insert a space only
when `item.x - (prevX + prevWidth) > 0.3 × fontHeight`. Collapses
"J un E 2010" → "June 2010" at the source.

```javascript
async function parsePDF(file) {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({
        x: item.transform[4], width: item.width,
        str: item.str, height: item.height || 10,
      });
    }
    const sortedY = [...lines.keys()].sort((a, b) => b - a);
    const lineTexts = sortedY.map(y => {
      const lineItems = lines.get(y).sort((a, b) => a.x - b.x);
      let text = '', prevEnd = null;
      for (const item of lineItems) {
        if (prevEnd !== null && item.x - prevEnd > item.height * 0.3) text += ' ';
        text += item.str;
        prevEnd = item.x + item.width;
      }
      return text.trim();
    }).filter(Boolean);
    pages.push(lineTexts.join('\n'));
  }
  return pages.join('\n\n');
}
```

### 2.2 Fragment rejoiner in `cleanText` (index.html:2413)

After the existing fi-ligature fix, add a careful post-pass for
residual 1–2 char fragments (leave "U.S." alone):

```javascript
text = text.replace(/\b([A-Za-z]{1,2})\s+([a-z]{3,})\b/g, (m, a, b) => {
  if (['a', 'i', 'o'].includes(a.toLowerCase())) return m;
  return a + b;
});
```

### 2.3 Tighten NP extraction

**`tagToken` (index.html:2449):** Require capitalised mid-sentence
tokens to be ≥ 3 chars and not in a sentence-starter list:

```javascript
const SENT_STARTERS = new Set([
  'however','further','thus','moreover','therefore',
  'nevertheless','nonetheless','additionally','furthermore'
]);
// Change the mid-sentence capital check to:
if (/^[A-Z]/.test(clean) && !sentStart && !DETS.has(wl) &&
    clean.length >= 3 && !SENT_STARTERS.has(wl)) return 'PROPER';
```

**`extractNPs` (index.html:2479):** Reject NPs whose only content
token is a single NOUN fallback unless frequency ≥ 4 AND z ≥ 1.0.

**`stageSIG_NPs` (index.html:2760):** Emit per-occurrence SIG with
`target: np:<canonical>` (the entity candidate anchor), not
`target: doc_anchor`. The 13,250-to-document SIG-spam happens because
all occurrences target the doc anchor. Keep one accumulation SIG per
cluster against the doc anchor as a summary signal.

Accumulation condition — raise to z > 1.0, cap at 6 tokens:

```javascript
if (count >= 2 && zScore > 1.0 && cluster.canonical.split(' ').length <= 6) {
  // emit accumulation SIG
}
```

### 2.4 Doc-length-aware INS threshold

`stageINS_threshold` (index.html:2855): for docs over 5,000 tokens,
raise the floor:

```javascript
const wordCount = text.split(/\s+/).length;
const floor = wordCount > 5000 ? 5 : 3;
const threshold = Math.max(floor, mean + 1.2 * sd);
```

The architectural fix (moving INS entirely to the fold worker) is
correct but larger. The threshold raise is the safe immediate step.
The migration is specified in the architectural section below.

### 2.5 O(s·m²) → O(s·m) CON loop (index.html:2974)

Build a regex union once per document. Scan each sentence once for
all matches. Enumerate pairs from the match list:

```javascript
function stageCON_cooccurrence(log, sentences, entityAnchors, da) {
  const norms = Object.keys(entityAnchors);
  if (!norms.length) return;
  const pattern = norms
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  const re = new RegExp(`\\b(${pattern})\\b`, 'gi');

  for (const sent of sentences) {
    const matches = [...sent.text.toLowerCase().matchAll(re)].map(m => m[1].toLowerCase());
    const present = [...new Set(matches)]
      .map(norm => ({ norm, ca: entityAnchors[norm] }))
      .filter(x => x.ca);
    if (present.length < 2) continue;
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const a = present[i], b = present[j];
        const verb = findVerbBetween(sent.text, a.norm, b.norm);
        log.push(makeEntry('CON',
          anchor(`cooc:${a.ca}:${b.ca}:${sent.start}`), a.ca,
          { object_anchor: b.ca,
            subject_text: toDisplayName(a.norm),
            object_text: toDisplayName(b.norm),
            relation_type: verb ? 'verb_cooccurrence' : 'co-occurrence',
            verb, sentence_fragment: sent.text.slice(0, 100) },
          { source: 'mechanical:cooccurrence',
            span_start: sent.start, span_end: sent.end,
            doc_anchor: da, confidence: verb ? 0.7 : 0.5 }
        ));
      }
    }
  }
}
```

### 2.6 Fix `findVerbBetween`

The current implementation normalizes NPs before searching, breaking
position calculation. Fix to use original-case text:

```javascript
function findVerbBetween(sentText, npA, npB) {
  const aFirst = npA.split(' ')[0];
  const bFirst = npB.split(' ')[0];
  const ia = sentText.toLowerCase().indexOf(aFirst.toLowerCase());
  const ib = sentText.toLowerCase().indexOf(bFirst.toLowerCase());
  if (ia < 0 || ib < 0 || ia === ib) return null;
  const start = Math.min(ia, ib) + Math.max(aFirst.length, bFirst.length);
  const end   = Math.max(ia, ib);
  if (start >= end) return null;
  const between = sentText.slice(start, end);
  const m = between.match(
    /\b(received|transferred|authorized|allocated|approved|declined|reported|stated|argued|demonstrated|showed|found|established|enabled|challenged|requires?|provides?|supports?|defines?|represents?|indicates?|\w+(?:ed|ing))\b/i
  );
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (STOP.has(w) || /(?:tion|ment|ness|ity|ance|ence)$/.test(w)) return null;
  return m[1];
}
```

### 2.7 Fix pronoun `surface_form`

`stageSIG_pronouns` writes `text: m[0]` but the coref system reads
`surface_form`. Add the field:

```javascript
operand: {
  text: m[0],
  surface_form: m[0],   // ← add
  detector: 'PRONOUN',
  resolution_status: 'unresolved',
  candidate_op: 'CON',
  note: 'Coreference resolution required',
}
```

### 2.8 Fix DEF frame labels

`stageFrameDEF` stores `value: frameHash` (an anchor hash). Add a
readable `frame_label` alongside:

```javascript
function buildFrameLabel(canonical, neighbors, relationTypes) {
  const relStr = relationTypes.length > 0
    ? `via ${relationTypes.slice(0, 2).join(', ')}` : 'by co-occurrence';
  const nbStr = neighbors.size > 0
    ? `related to ${[...neighbors].slice(0, 3).map(a => resolveDisplayName(a)).join(', ')}`
    : 'no structural neighbors yet';
  return `${toDisplayName(canonical)}: ${nbStr} ${relStr}`;
}
// In stageFrameDEF operand: add frame_label: buildFrameLabel(...)
```

### 2.9 EVA calibration check

After first 100 clause results, compute flat rate. Log advisory if > 60%:

```javascript
const sample = results.slice(0, Math.min(100, results.length));
const flatRate = sample.filter(r => r.confidence_gap < 0.08).length / sample.length;
if (flatRate > 0.60) {
  log.push(makeEntry('DEF',
    anchor('def:classifier_mode:' + da), da,
    { param: 'classifier_mode', value: 'flat_profile_detected',
      flat_rate: parseFloat(flatRate.toFixed(3)),
      note: `${Math.round(flatRate * 100)}% flat profiles — centroid undiscriminating` },
    { source: 'mechanical:calibration_check', doc_anchor: da, confidence: 1.0 }
  ));
}
// This DEF entry also triggers the EVA notice strip (1.3) in the UI.
```

---

## Layer 3 — Make the learning loop visible

### 3.1 Live operator ticker

Add a ring buffer (last 20 events) displayed as a thin strip. Subscribe
via the existing `eo-fold` BroadcastChannel. Add
`postMessage({op:'fold_event', entry})` at the end of `foldDEF`,
`foldEVA`, `foldREC`, and `foldINS` in `workers/fold-worker.js`.

Each line: `DEF  built  "polycentric" → governance form`. Lines fade
after 4s, remain scrollable on hover.

### 3.2 Enriched progress narration

`setStage` calls inside `ingest` (index.html:3615–3698) already name
stages. Enrich with counts and embedding status:

```
"SEG · 412 sentences · 1,230 clauses"
"SIG · 87 NP clusters (34 qualify z>1.0 gate)"
"INS · 14 entities promoted (9 after quality filter)"
"CON · 63 predicate edges · 412 co-occurrences"
"EMBED · Xenova/all-MiniLM-L6-v2 · 384d · ready"
  OR "EMBED · classifier unavailable — skipping"
  OR "EMBED · 92% flat profiles — centroids undiscriminating for this domain"
```

Surface the classifier load/failure state explicitly. The current
silent-degrade path at index.html:2011 is the source of user confusion.

### 3.3 Evolving entity profiles

The entity profile card (1.6) auto-refreshes when the fold-worker
emits `m_update` for the open anchor (already emitted at
`workers/fold-worker.js:111`). New DEF pops into the DEF block, new
EVA appears as a badge. The profile visibly fills in as the system
reads.

---

## Files to modify

**index.html:**

| Location | Change |
|---|---|
| `parsePDF` (≈5824) | positional join |
| `cleanText` (≈2413) | fragment rejoiner |
| `tagToken / extractNPs / stageSIG_NPs` (≈2449–2790) | NP quality gates + SIG target fix |
| `findVerbBetween` | original-case fix |
| `stageSIG_pronouns` | add `surface_form` field |
| `stageINS_threshold` (≈2855) | doc-length-aware floor |
| `stageCON_cooccurrence` (≈2974) | O(s·m) rewrite |
| `stageFrameDEF` | add `frame_label` field |
| `stageEmbeddingClassify` | flat-rate calibration check |
| near `toDisplayName` (≈2561) | add `isDisplayableEntity`, `hasPredicate` |
| `buildAnnotatedHTML` (≈4654) | dormant highlights + grain strip |
| `wireDocViewerClicks` (≈5365) | click → entity profile |
| `rCtxStrip` / `ctx-body` (≈7732) | entity profile card |
| `#rail-list` populator (≈7375) | ranked entity rail |
| graph renderer (`#gsvg / #gleg / #gcnt`) | predicate filter + empty state |
| `renderStats` (≈5621) | ticker mount |
| `ingest.setStage` calls (≈3621–3694) | enriched narration |
| `#hdr` (≈7343) | dynamic corpus header |
| CSS | dormant `.anno`, `.anno-focus`, ticker, grain strip, EVA notice |

**workers/fold-worker.js:**

| Location | Change |
|---|---|
| `foldINS / foldDEF / foldEVA / foldREC` | add `postMessage({op:'fold_event', entry})` |
| `m_update` (line 111) | already emits — main thread hooks for profile card refresh |

---

## Sequence of changes

Items 1–9 can be done in any order and tested independently.
Items 10–12 are a coordinated architectural change — do not start
until Items 1–9 are verified on the Ostrom PDF.

**Immediate (Layer 1 + quick source fixes):**

1. `surface_form: m[0]` in pronoun SIG operand — 5 min
2. z > 1.0 + 6-token cap in accumulation SIG + SIG target to `np:<canonical>` — 10 min
3. `findVerbBetween` original-case fix — 20 min
4. `frame_label` in DEF frame entries — 10 min
5. Flat-rate calibration check in `stageEmbeddingClassify` — 20 min
6. `isDisplayableEntity` + `hasPredicate` helpers — 20 min
7. Wire `isDisplayableEntity` into rail, annotations, header — 20 min
8. Predicate-required graph + honest empty state — 20 min
9. EVA confidence notice strip — 20 min

**This week (Layer 2 source fixes + Layer 3):**

10. Position-aware PDF join + fragment rejoiner — 45 min
11. O(s·m) CON loop rewrite — 30 min
12. INS threshold floor: `max(5, mean + 1.2σ)` for docs > 5k tokens — 10 min
13. Ranked entity rail with interestingness score — 30 min
14. Click → entity profile card — 45 min
15. Grain indicator strip — 20 min
16. Live operator ticker (fold-worker `postMessage` + main-thread ring buffer) — 30 min
17. Enriched progress narration — 20 min
18. Dynamic corpus header — 10 min

---

## Verification

Serve from `/home/user/nl-explorer`, ingest the Ostrom PDF.

| Check | Expected |
|---|---|
| Word integrity | "June 2010", "polycentric", "self-organized" render as whole words |
| Readability | Doc reads as prose — no background highlights until hover |
| Entity rail | ≤ ~30 entities; no citation fragments; Ostrom, IAD framework, common-pool resources visible |
| Graph | Empty with explicit "no directed relationships yet" message |
| EVA notice | Visible bar: "900 of 978 clauses below threshold · [Run H3 tiebreak]" |
| Click | Clicking a span opens entity profile card; raw events under disclosure |
| Grain strip | "reading at: sentence ▾" visible; dropdown re-renders |
| Ticker | DEF/EVA/REC/INS events stream live during and after ingest |
| Progress | Per-stage counts + explicit embedding status line |
| Header | `corpus: OstromPolyGov · 1 doc · N entities` (filtered count) |
| Speed | 30-page PDF ingests in < 15s (`console.time('ingest')`) |

---

## Architectural migration (follow-on, not blocking)

The correct long-term fix for entity quality is to remove
`stageINS_threshold` entirely and let the fold worker's
integral-crossing path own all INS events:

- Fold worker emits INS + display_name DEF and notifies main thread
- Main thread ingest produces only SIG events for entities
- CON stage defers until fold worker confirms both endpoints are INS'd
- Narrator detection fires before body processing for first-person docs

This is a larger coordinated change. All items above are compatible
with it and do not block it. The threshold-floor raise (Item 12) is
the safe interim improvement. The full migration is specified in the
integral coreference spec.
