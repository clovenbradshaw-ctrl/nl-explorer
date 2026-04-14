# EO Embedding Classification System
## DEF→EVA→REC Continuous Improvement Architecture
**Technical Specification · v0.2 · April 2026**

---

## 1. Purpose

This system assigns each clause extracted from an ingested document to one of 27 semantic cells in EO's capacity ground (Mode × Domain × Object), using a lightweight in-browser embedding model compared against pre-computed centroids derived from the cross-linguistic empirical corpus. The classification is a nearest-centroid lookup — deterministic, auditable, and offline.

The 27 cell positions are stable attractors encoding semantic pockets that natural language has always encoded. The system does not move the centroids. It improves the domain adapter — the mapping from surface text to embedding — through the DEF→EVA→REC cycle applied to accumulated classification evidence.

### Why this is possible

The empirical study (19,764 clauses, 41 languages, dual annotation) confirmed that EO's three axes produce genuine geometric separation in embedding space:

| Grouping | z-score |
|---|---|
| Q1 — Mode alone | +2.17 |
| Q2 — Domain alone | +4.09 |
| Q3 — Object alone | +4.81 |
| Act face (Mode × Domain) | +9.24 |
| Site face (Domain × Object) | +9.44 |
| **Resolution face (Mode × Object)** | **+12.70** |
| Full 27-cell | +16.15 |

---

## 2. Repository

**Source data:** `https://github.com/clovenbradshaw-ctrl/eo-lexical-analysis`

```
eo-lexical-analysis/
├── data/
│   └── exemplars.json          # 27-cell → operator notation → ranked clause list
├── output/
│   ├── results.json            # per-cell z-scores, ARI, kappa
│   └── analysis_report.txt    # full study results
└── scripts/
    └── app.py                  # original pipeline
```

### exemplars.json structure

```json
{
  "27cell": {
    "NUL(Clearing, Void)": [
      {
        "text": "La rajina non esiste più.",
        "lang": "it",
        "margin": 0.098,
        "q1": "differentiating",
        "q2": "existence",
        "q3": "condition"
      }
    ],
    "CON(Binding, Link)": [ ... ]
  },
  "act_face": { "NUL": [...], "SIG": [...], ... },
  "site_face": { ... },
  "resolution_face": { ... }
}
```

**Cell key format:** `OPERATOR(Resolution_verb, Site_noun)`
**margin field:** discrimination margin — how far the clause sits from its nearest competing cell. Higher = more unambiguous. Use this for top-N selection.

> **Verify the exact key format from the actual file before building Phase 1.** The format assumed here (`OPERATOR(Resolution, Site)`) may differ slightly.

### 27-cell coordinate map

| Cell key | Operator | Mode | Domain | Object |
|---|---|---|---|---|
| NUL(Clearing, Void) | NUL | Differentiating | Existence | Condition |
| SIG(Binding, Entity) | SIG | Relating | Existence | Entity |
| INS(Making, Pattern) | INS | Generating | Existence | Pattern |
| SEG(Clearing, Field) | SEG | Differentiating | Structure | Condition |
| CON(Binding, Link) | CON | Relating | Structure | Entity |
| SYN(Making, Network) | SYN | Generating | Structure | Pattern |
| EVA(Clearing, Lens) | EVA | Differentiating | Significance | Condition |
| DEF(Binding, Paradigm) | DEF | Relating | Significance | Entity |
| REC(Making, Paradigm) | REC | Generating | Significance | Pattern |

There are 27 cells total — the 9 above × 3 Object levels (Condition/Entity/Pattern), producing all combinations of Mode × Domain × Object.

---

## 3. Phase 1 — Centroid Generation (Python, Offline)

**Input:** `exemplars.json`
**Output:** `centroids.json`, `alignment_matrix.json`, `centroid_stats.json`
**Runtime:** ~15–30 min CPU, ~3–5 min GPU

### 3.1 Dependencies

```bash
pip install sentence-transformers numpy scipy torch
```

### 3.2 Script: `generate_centroids.py`

```python
import json
import numpy as np
from scipy.linalg import orthogonal_procrustes
from sentence_transformers import SentenceTransformer

MULTILINGUAL_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2'
SMALL_MODEL        = 'all-MiniLM-L6-v2'
TOP_N              = 100
MIN_MARGIN         = 0.03
ALIGNMENT_N        = 500
BATCH_SIZE         = 64

with open('data/exemplars.json') as f:
    data = json.load(f)
cells = data['27cell']

# Select top-N consensus exemplars per cell
selected = {}
all_english = []
for cell_key, exemplars in cells.items():
    ranked = sorted(exemplars, key=lambda x: x.get('margin', 0), reverse=True)
    top = [e for e in ranked if e.get('margin', 0) >= MIN_MARGIN][:TOP_N]
    if not top:
        top = ranked[:min(10, len(ranked))]
    selected[cell_key] = [e['text'] for e in top]
    all_english.extend([e['text'] for e in top if e.get('lang') == 'en'])
    print(f"  {cell_key}: {len(top)} exemplars")

# Embed with multilingual model
ml_model = SentenceTransformer(MULTILINGUAL_MODEL)
centroids = {}
centroid_stats = {}

for cell_key, texts in selected.items():
    embeddings = ml_model.encode(
        texts, batch_size=BATCH_SIZE, normalize_embeddings=True
    )
    centroid = embeddings.mean(axis=0)
    centroid /= np.linalg.norm(centroid)
    intra_variance = float(np.mean([1 - float(np.dot(e, centroid)) for e in embeddings]))
    centroids[cell_key] = centroid.tolist()
    centroid_stats[cell_key] = {
        'exemplar_count': len(texts),
        'mean_margin': float(np.mean([
            e.get('margin', 0) for e in sorted(
                cells[cell_key], key=lambda x: x.get('margin',0), reverse=True
            )[:TOP_N]
        ])),
        'intra_variance': intra_variance
    }

OP_MAP = {
    'NUL': {'mode': 'Differentiating', 'domain': 'Existence'},
    'SIG': {'mode': 'Relating',        'domain': 'Existence'},
    'INS': {'mode': 'Generating',      'domain': 'Existence'},
    'SEG': {'mode': 'Differentiating', 'domain': 'Structure'},
    'CON': {'mode': 'Relating',        'domain': 'Structure'},
    'SYN': {'mode': 'Generating',      'domain': 'Structure'},
    'EVA': {'mode': 'Differentiating', 'domain': 'Significance'},
    'DEF': {'mode': 'Relating',        'domain': 'Significance'},
    'REC': {'mode': 'Generating',      'domain': 'Significance'},
}

centroid_records = []
for cell_key, vector in centroids.items():
    op = cell_key.split('(')[0]
    inner = cell_key[len(op)+1:-1]
    parts = [p.strip() for p in inner.split(',')]
    cell_id = cell_key.replace('(','_').replace(')','').replace(', ','_').replace(' ','_')
    centroid_records.append({
        'cell_id':    cell_id,
        'cell_key':   cell_key,
        'operator':   op,
        'resolution': parts[0] if parts else '',
        'site':       parts[1] if len(parts) > 1 else '',
        **OP_MAP.get(op, {}),
        'vector':     vector,
        **centroid_stats[cell_key]
    })

with open('centroids.json', 'w') as f:
    json.dump(centroid_records, f)
print(f"Wrote centroids.json ({len(centroid_records)} cells)")

# Procrustes alignment: multilingual → small model
alignment_texts = all_english[:ALIGNMENT_N]
small_model = SentenceTransformer(SMALL_MODEL)
ml_align = ml_model.encode(alignment_texts,  normalize_embeddings=True)
sm_align = small_model.encode(alignment_texts, normalize_embeddings=True)
R, scale = orthogonal_procrustes(sm_align, ml_align)
residual = float(np.mean(np.linalg.norm(sm_align @ R - ml_align, axis=1)))
print(f"Alignment residual: {residual:.4f}")

with open('alignment_matrix.json', 'w') as f:
    json.dump({'R': R.tolist(), 'scale': float(scale), 'residual': residual,
               'n': len(alignment_texts), 'multilingual_model': MULTILINGUAL_MODEL,
               'small_model': SMALL_MODEL}, f)

# Validation
vectors = np.array([r['vector'] for r in centroid_records])
intra, inter = [], []
for i, r1 in enumerate(centroid_records):
    for j, r2 in enumerate(centroid_records):
        sim = float(np.dot(r1['vector'], r2['vector']))
        if r1['operator'] == r2['operator'] and i != j: intra.append(sim)
        elif r1['operator'] != r2['operator']:           inter.append(sim)

print(f"Intra-operator centroid similarity: {np.mean(intra):.3f}")
print(f"Inter-operator centroid similarity: {np.mean(inter):.3f}")
print(f"Separation: {np.mean(intra) - np.mean(inter):.3f} (positive = good)")

with open('centroid_stats.json', 'w') as f:
    json.dump({'stats': centroid_stats, 'mean_intra': float(np.mean(intra)),
               'mean_inter': float(np.mean(inter)),
               'separation': float(np.mean(intra)-np.mean(inter))}, f, indent=2)
```

### 3.3 Expected outputs

```json
// centroids.json — array of 27
[{
  "cell_id": "NUL_Clearing_Void",
  "cell_key": "NUL(Clearing, Void)",
  "operator": "NUL",
  "resolution": "Clearing",
  "site": "Void",
  "mode": "Differentiating",
  "domain": "Existence",
  "vector": [0.043, -0.127, "...384 floats..."],
  "exemplar_count": 97,
  "mean_margin": 0.071,
  "intra_variance": 0.018
}]
```

---

## 4. Phase 2 — In-Browser Inference

**New file:** `eo_classifier.js`
**Modify:** `eo_ingest.html`

### 4.1 `eo_classifier.js`

```javascript
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

const CONF_THRESHOLD = {
  latin: 0.08, cyrillic: 0.06, arabic: 0.04,
  devanagari: 0.04, cjk: 0.04, default: 0.05,
};

let _embedder = null, _centroids = null, _alignMatrix = null, _ready = false;

export async function initClassifier(centroidsUrl, alignmentUrl) {
  _embedder  = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
  _centroids = await (await fetch(centroidsUrl)).json();
  if (alignmentUrl) {
    try {
      const d = await (await fetch(alignmentUrl)).json();
      _alignMatrix = new Float32Array(DIM * DIM);
      for (let i = 0; i < DIM; i++)
        for (let j = 0; j < DIM; j++)
          _alignMatrix[i * DIM + j] = d.R[i][j];
    } catch(e) { console.warn('No alignment matrix'); }
  }
  _ready = true;
}

export function isReady() { return _ready; }

async function embedText(text) {
  const out = await _embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

function applyAlignment(v) {
  if (!_alignMatrix) return v;
  const r = new Float32Array(DIM);
  for (let j = 0; j < DIM; j++) {
    let s = 0;
    for (let i = 0; i < DIM; i++) s += v[i] * _alignMatrix[i * DIM + j];
    r[j] = s;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += r[i]*r[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) r[i] /= norm;
  return Array.from(r);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export async function classifyClause(text, script, mechanicalOp) {
  if (!_ready) throw new Error('Classifier not initialized');
  let v = await embedText(text);
  v = applyAlignment(v);
  const scores = _centroids.map(c => ({
    ...c, score: cosine(v, c.vector)
  })).sort((a,b) => b.score - a.score);
  const gap = scores[0].score - scores[1].score;
  const threshold = CONF_THRESHOLD[script] || CONF_THRESHOLD.default;
  const flags = [];
  if (script && script !== 'latin' && gap < 0.08) flags.push('low_confidence_nolatin');
  if (gap < threshold) flags.push('boundary');
  if (mechanicalOp && mechanicalOp !== scores[0].operator) flags.push('mechanical_conflict');
  return {
    cell_id: scores[0].cell_id, cell_key: scores[0].cell_key,
    operator: scores[0].operator, site: scores[0].site,
    resolution: scores[0].resolution, mode: scores[0].mode,
    domain: scores[0].domain,
    confidence_gap: parseFloat(gap.toFixed(4)),
    similarity_profile: scores.map(s => ({ cell_id: s.cell_id, score: parseFloat(s.score.toFixed(4)) })),
    mechanical_operator: mechanicalOp || null,
    agreement: mechanicalOp ? mechanicalOp === scores[0].operator : null,
    flags, script: script || 'unknown',
  };
}

export async function classifyClauses(clauses, script, mechOps, onProgress) {
  const results = [];
  for (let i = 0; i < clauses.length; i++) {
    results.push(await classifyClause(clauses[i].text, script, mechOps?.[i]));
    if (onProgress) onProgress(i+1, clauses.length);
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return results;
}
```

### 4.2 Changes to `eo_ingest.html`

**1. Import classifier** — add at top of `<script>` block (requires `type="module"` on the script tag, or use dynamic import):

```javascript
// At top of script — if using type="module":
import { initClassifier, classifyClauses, isReady } from './eo_classifier.js';

// On DOMContentLoaded:
initClassifier('centroids.json', 'alignment_matrix.json').then(() => {
  document.getElementById('classifier-status').textContent = '○ Classifier ready';
}).catch(() => {
  document.getElementById('classifier-status').textContent = '○ Classifier unavailable';
});
```

**2. Add status indicator** to header HTML:

```html
<span id="classifier-status" style="font-size:11px;color:var(--muted)">
  Loading classifier...
</span>
```

**3. Add `stageEmbeddingClassify`** (insert after `stageFrameDEF` in `ingest()`):

```javascript
async function stageEmbeddingClassify(log, da) {
  if (!isReady()) return;
  const clauseEntries = log.byOp('SEG').filter(e =>
    e.operand?.type === 'clause' && e.provenance?.doc_anchor === da
  );
  if (!clauseEntries.length) return;

  const clauses  = clauseEntries.map(e => ({ text: e.operand.text }));
  const mechOps  = clauseEntries.map(() => null);  // extend later with _getMechanicalOp

  const results = await classifyClauses(clauses, _currentScript, mechOps,
    (done, total) => {
      document.getElementById('parsing-label').textContent =
        `Classifying ${done}/${total} clauses…`;
    }
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i], seg = clauseEntries[i];
    log.push(makeEntry('EVA', anchor('eva:emb:' + seg.anchor + ':' + r.cell_id),
      seg.anchor, {
        eva_type: 'embedding_classification',
        cell_id: r.cell_id, cell_key: r.cell_key,
        operator: r.operator, site: r.site, resolution: r.resolution,
        mode: r.mode, domain: r.domain,
        confidence_gap: r.confidence_gap,
        similarity_profile: r.similarity_profile,
        mechanical_operator: r.mechanical_operator,
        agreement: r.agreement, flags: r.flags,
        notation: `${r.operator}(${r.site}, ${r.resolution})`,
      }, {
        source: 'mechanical:embedding_classify',
        span_start: seg.provenance?.span_start,
        span_end: seg.provenance?.span_end,
        doc_anchor: da, script: _currentScript,
        model_version: 'all-MiniLM-L6-v2',
        centroid_version: 'v1.0',
        confidence: Math.min(0.4 + r.confidence_gap * 4, 0.95),
      }
    ));
  }
}
```

**4. Make `ingest()` async**:

```javascript
async function ingest(text, title, source) {
  // ... existing stages ...
  stageFrameDEF(log, entityAnchors, da);
  await stageEmbeddingClassify(log, da);   // ← new, async
  stageEVA_temporal(log, text, da);
  // ...
  return { log, doc_anchor: da };
}
```

**5. Update `runIngest()`** to use `.then()` instead of `setTimeout`:

```javascript
function runIngest() {
  // ... setup ...
  ingest(text, title, title).then(({ log, doc_anchor }) => {
    // ... existing rebuild logic ...
    stageEmbeddingLoop(state.combined);  // Phase 3
    renderAll();
    document.getElementById('btn-process').disabled = false;
    // ...
  });
}
```

**6. Update `entryMainText`** for embedding EVA:

```javascript
if (op === 'EVA') {
  if (e.operand?.eva_type === 'embedding_classification') {
    const notation = e.operand.notation || `${e.operand.operator}(?)`;
    const gap = e.operand.confidence_gap?.toFixed(3) || '?';
    const flags = e.operand.flags?.length ? ` ⚑${e.operand.flags.join(',')}` : '';
    const agree = e.operand.agreement === false ? ' ≠mech' : '';
    return `EVA [embed] ${notation} · gap=${gap}${agree}${flags}`;
  }
  if (e.operand?.eva_type === 'embedding_pressure') {
    return `EVA [pressure] ${e.operand.cell_id} z=${e.operand.z_score?.toFixed(2)}σ · ${e.operand.conflict_count} conflicts`;
  }
  // ... existing cases ...
}
```

---

## 5. Phase 3 — DEF→EVA→REC Loop

Add all three functions to `eo_ingest.html`. Call `stageEmbeddingLoop(state.combined)` in `runIngest()` after all other combined-log stages.

### 5.1 Domain adapter — `stageDomainAdapter`

```javascript
function stageDomainAdapter(combinedLog) {
  const entries = combinedLog.entries();
  const highConf = entries.filter(e =>
    e.op === 'EVA' &&
    e.operand?.eva_type === 'embedding_classification' &&
    e.operand?.confidence_gap >= 0.12 &&
    e.operand?.agreement !== false
  );
  if (!highConf.length) return;

  const byCell = {};
  for (const e of highConf) {
    const cid = e.operand.cell_id;
    if (!byCell[cid]) byCell[cid] = [];
    byCell[cid].push(e);
  }

  for (const [cellId, evas] of Object.entries(byCell)) {
    if (evas.length < 5) continue;
    const topCells = evas.map(e =>
      e.operand.similarity_profile.slice(0, 3).map(s => s.cell_id).join(',')
    );
    const sigFreq = {};
    for (const s of topCells) sigFreq[s] = (sigFreq[s]||0) + 1;
    const dominantSig = Object.entries(sigFreq).sort((a,b)=>b[1]-a[1])[0]?.[0];
    const a = anchor('def:domain_adapter:' + cellId);
    if (entries.some(e => e.anchor === a && e.operand?.dominant_signature === dominantSig)) continue;

    combinedLog.push(makeEntry('DEF', a, anchor('cell:' + cellId), {
      param: 'domain_centroid',
      value: cellId,
      n: evas.length,
      mean_confidence_gap: parseFloat((evas.reduce((s,e)=>s+e.operand.confidence_gap,0)/evas.length).toFixed(4)),
      dominant_signature: dominantSig,
      agreement_rate: parseFloat((evas.filter(e=>e.operand.agreement).length/evas.length).toFixed(3)),
      note: 'domain adapter — not a centroid replacement',
    }, { source: 'mechanical:domain_adapter', confidence: Math.min(0.5+evas.length*0.01,0.85) }));
  }
}
```

### 5.2 Embedding pressure — `stageEVA_embedding`

```javascript
function stageEVA_embedding(combinedLog) {
  const entries = combinedLog.entries();
  const embEVAs = entries.filter(e =>
    e.op === 'EVA' && e.operand?.eva_type === 'embedding_classification'
  );
  if (embEVAs.length < 20) return;

  const cellStats = {};
  for (const e of embEVAs) {
    const cid = e.operand.cell_id;
    if (!cellStats[cid]) cellStats[cid] = { total:0, conflicts:0, boundaries:0, mech_conflicts:0 };
    const s = cellStats[cid];
    s.total++;
    if (e.operand.flags?.includes('boundary')) s.boundaries++;
    if (e.operand.flags?.includes('mechanical_conflict')) s.mech_conflicts++;
    if (e.operand.flags?.includes('boundary') && e.operand.flags?.includes('mechanical_conflict'))
      s.conflicts++;
  }

  const cells = Object.entries(cellStats);
  if (cells.length < 3) return;
  const rates = cells.map(([,s]) => s.total > 0 ? s.conflicts/s.total : 0);
  const mean = rates.reduce((a,b)=>a+b,0)/rates.length;
  const sd   = Math.sqrt(rates.reduce((a,b)=>a+(b-mean)**2,0)/rates.length) || 0.001;

  for (let i = 0; i < cells.length; i++) {
    const [cellId, s] = cells[i];
    const z = (rates[i] - mean) / sd;
    if (Math.abs(z) < 0.5) continue;
    const a = anchor('eva:emb_pressure:' + cellId);
    if (entries.some(e => e.anchor === a)) continue;
    combinedLog.push(makeEntry('EVA', a, anchor('cell:' + cellId), {
      eva_type: 'embedding_pressure',
      cell_id: cellId,
      result: z > 1.5 ? 'conflicts' : z > 0.5 ? 'extends' : 'satisfies',
      z_score: parseFloat(z.toFixed(3)),
      total: s.total, conflict_count: s.conflicts,
      boundary_count: s.boundaries, mech_conflict: s.mech_conflicts,
      conflict_rate: parseFloat((s.total > 0 ? s.conflicts/s.total : 0).toFixed(3)),
    }, { source: 'mechanical:eva_embedding_pressure', confidence: Math.min(0.6+s.total*0.005,0.9) }));
  }
}
```

### 5.3 REC for embedding — `stageREC_embedding`

```javascript
function stageREC_embedding(combinedLog) {
  const entries = combinedLog.entries();
  const pressureEVAs = entries.filter(e =>
    e.op === 'EVA' && e.operand?.eva_type === 'embedding_pressure' && e.operand?.z_score > 1.5
  );
  for (const pEVA of pressureEVAs) {
    const cellId = pEVA.operand.cell_id;
    const ra = anchor('rec:emb:' + cellId);
    if (entries.some(e => e.anchor === ra)) continue;

    const altCounts = {};
    for (const e of entries) {
      if (e.op !== 'EVA' || e.operand?.eva_type !== 'embedding_classification') continue;
      if (!e.operand?.flags?.includes('boundary')) continue;
      const second = e.operand.similarity_profile?.[1]?.cell_id;
      if (second && second !== cellId) altCounts[second] = (altCounts[second]||0)+1;
    }
    const topAlt = Object.entries(altCounts).sort((a,b)=>b[1]-a[1])[0];
    const sampleClauses = entries
      .filter(e => e.op==='EVA' && e.operand?.eva_type==='embedding_classification'
        && e.operand?.cell_id===cellId && e.operand?.flags?.includes('boundary'))
      .slice(0,5).map(e => e.target);

    combinedLog.push(makeEntry('REC', ra, anchor('cell:' + cellId), {
      trigger: 'embedding_cell_pressure',
      cell_id: cellId,
      z_score: pEVA.operand.z_score,
      conflict_count: pEVA.operand.conflict_count,
      competing_cell: topAlt?.[0] || null,
      competing_count: topAlt?.[1] || 0,
      sample_clauses: sampleClauses,
      resolution_options: [
        'accept_boundary — add to boundary exemplar set',
        'domain_mapping — surface form means this cell in this domain',
        'flag_for_corpus — needs new exemplars in next centroid version',
      ],
      new_frame: null,
      resolution: 'pending_human',
      note: `Cell ${cellId} under embedding pressure z=${pEVA.operand.z_score.toFixed(2)} — competing with ${topAlt?.[0]||'unknown'}`,
    }, { source: 'mechanical:rec_embedding', confidence: Math.min(0.7+pEVA.operand.conflict_count*0.02,0.92) }));
  }
}
```

### 5.4 Entry point — `stageEmbeddingLoop`

```javascript
function stageEmbeddingLoop(combinedLog) {
  stageDomainAdapter(combinedLog);
  stageEVA_embedding(combinedLog);
  stageREC_embedding(combinedLog);
}
```

---

## 6. Phase 4 — Multilingual Extension

### 6.1 Lazy-load multilingual model for non-Latin scripts

```javascript
const ML_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';  // 118MB
let _mlEmbedder = null;

async function getEmbedder(script) {
  if (!script || script === 'latin' || script === 'cyrillic') return _embedder;
  if (!_mlEmbedder) {
    document.getElementById('parsing-label').textContent = 'Loading multilingual model…';
    _mlEmbedder = await pipeline('feature-extraction', ML_MODEL_ID, { quantized: true });
  }
  return _mlEmbedder;
}
// Update embedText() to call getEmbedder(_currentScript) instead of _embedder
```

---

## 7. File Manifest

| File | Type | Notes |
|---|---|---|
| `generate_centroids.py` | Python | Phase 1 — run once offline |
| `centroids.json` | Static JSON ~40KB | Generated by Phase 1, bundled with app |
| `alignment_matrix.json` | Static JSON ~600KB | Generated by Phase 1, bundled with app |
| `centroid_stats.json` | Static JSON ~8KB | Diagnostics only |
| `eo_classifier.js` | ES Module | Phase 2 — new file |
| `eo_ingest.html` | Modified | Phases 2, 3, 4 changes |

All files are static. No server required. Transformers.js model downloads on first use and caches in IndexedDB.

---

## 8. Key Invariants

- The 27 centroids **never change at runtime**
- The **full similarity profile** (all 27 scores) is always stored
- Domain centroid candidates are **DEF entries**, not centroid replacements
- REC fires on **cell pressure**, not individual failures
- Mechanical and embedding signals are stored **independently**
- Non-English classifications are **flagged, not suppressed**

---

## 9. Open Questions

| Question | Decision needed |
|---|---|
| Alignment matrix necessity | Test direct comparison vs. Procrustes — may be unnecessary |
| Confidence thresholds | Calibrate 0.08/0.04 against validation set in `results.json` |
| Domain centroid activation threshold | Start with n=20 high-confidence examples |
| `exemplars.json` exact key format | **Verify before building Phase 1** |
| `type="module"` on script tag | Confirm or use dynamic import fallback |
| int8 quantization precision | Verify `Xenova/all-MiniLM-L6-v2` int8 produces sufficient precision |
| centroid_version history | Plan migration path for when centroids are regenerated |

---

## 10. Falsifiability

Every typed log entry carries its own falsification conditions structurally — not as attached metadata but as a function of the operator type:

- **NUL classifications** falsified by a subsequent SIG at the same anchor
- **CON classifications** falsified by structural incompatibility in SYN topology
- **DEF classifications** explicitly falsified by EVA `conflicts` result
- **EVA embedding entries** falsified by: accumulated REC pressure on the winning cell; human REC resolution assigning a different cell to the same surface pattern; reclassification under a new centroid version producing a different result

The similarity profile stored in every EVA entry is the auditable evidence chain. The classification is a geometric measurement, not an assertion.

---

*EO Embedding Classification System · Technical Specification v0.2 · April 2026*
