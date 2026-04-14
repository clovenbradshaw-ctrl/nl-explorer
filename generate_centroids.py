"""
EO Embedding Classification System — Phase 1
Centroid Generation (offline, Python)

Inputs:
  exemplars.json (auto-discovered: $1 CLI arg, ./exemplars.json,
  ./data/exemplars.json, alongside this script, or downloaded from
  the canonical upstream URL).
Outputs:
  centroids.json
  alignment_matrix.json
  centroid_stats.json

Runtime: ~15-30 min CPU, ~3-5 min GPU

Dependencies:
  pip install sentence-transformers numpy scipy torch
"""

import json
import os
import sys
import urllib.request
import numpy as np
from scipy.linalg import orthogonal_procrustes
from sentence_transformers import SentenceTransformer

MULTILINGUAL_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2'
SMALL_MODEL        = 'all-MiniLM-L6-v2'
TOP_N              = 100
MIN_MARGIN         = 0.03
ALIGNMENT_N        = 500
BATCH_SIZE         = 64

EXEMPLARS_URL = (
    'https://raw.githubusercontent.com/clovenbradshaw-ctrl/'
    'eo-lexical-analysis-2.0/main/run_2026-03-19_144302/exemplars.json'
)

def load_exemplars():
    """Load exemplars.json from CLI arg, common local paths, or download."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = []
    if len(sys.argv) > 1:
        candidates.append(sys.argv[1])
    candidates += [
        'exemplars.json',
        'data/exemplars.json',
        os.path.join(script_dir, 'exemplars.json'),
        os.path.join(script_dir, 'data', 'exemplars.json'),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            print(f"Loading exemplars from {path}")
            with open(path) as f:
                return json.load(f)
    print(f"No local exemplars.json found. Downloading from {EXEMPLARS_URL}")
    cache_path = os.path.join(script_dir, 'exemplars.json')
    with urllib.request.urlopen(EXEMPLARS_URL) as resp:
        payload = resp.read()
    with open(cache_path, 'wb') as f:
        f.write(payload)
    print(f"Cached to {cache_path}")
    return json.loads(payload)

# Schema (per exemplars.json _legend):
#   clause           — sentence text (older corpora used "text")
#   language         — ISO 639-1 code (older: "lang")
#   margin_composite — ranking key for 27cell (min margin across all faces)
#   margin_face      — fallback for per-face exemplar sets
def margin_of(e):
    for k in ('margin_composite', 'margin_face', 'margin'):
        v = e.get(k)
        if isinstance(v, (int, float)):
            return v
    return 0

def text_of(e):
    for k in ('clause', 'text'):
        v = e.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return ''

def lang_of(e):
    return e.get('language') or e.get('lang') or 'en'

data = load_exemplars()
cells = data['27cell']

# Select top-N consensus exemplars per cell
selected = {}
all_english = []
skipped = 0
for cell_key, exemplars in cells.items():
    usable = [e for e in exemplars if text_of(e)]
    skipped += len(exemplars) - len(usable)
    ranked = sorted(usable, key=margin_of, reverse=True)
    top = [e for e in ranked if margin_of(e) >= MIN_MARGIN][:TOP_N]
    if not top:
        top = ranked[:min(10, len(ranked))]
    selected[cell_key] = [text_of(e) for e in top]
    all_english.extend([text_of(e) for e in top if lang_of(e) == 'en'])
    print(f"  {cell_key}: {len(top)} exemplars")
if skipped:
    print(f"  (skipped {skipped} exemplars with missing/empty text)")
if not any(selected.values()):
    raise SystemExit('No usable exemplars (all entries missing text)')

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
    top_for_stats = sorted(cells[cell_key], key=margin_of, reverse=True)[:TOP_N]
    centroid_stats[cell_key] = {
        'exemplar_count': len(texts),
        'mean_margin': float(np.mean([margin_of(e) for e in top_for_stats])) if top_for_stats else 0.0,
        'intra_variance': intra_variance,
    }

# Operator keys match the exemplars.json _legend (Significance row is ALT/SUP/REC).
OP_MAP = {
    'NUL': {'mode': 'Differentiating', 'domain': 'Existence'},
    'SIG': {'mode': 'Relating',        'domain': 'Existence'},
    'INS': {'mode': 'Generating',      'domain': 'Existence'},
    'SEG': {'mode': 'Differentiating', 'domain': 'Structure'},
    'CON': {'mode': 'Relating',        'domain': 'Structure'},
    'SYN': {'mode': 'Generating',      'domain': 'Structure'},
    'ALT': {'mode': 'Differentiating', 'domain': 'Significance'},
    'SUP': {'mode': 'Relating',        'domain': 'Significance'},
    'REC': {'mode': 'Generating',      'domain': 'Significance'},
}

centroid_records = []
for cell_key, vector in centroids.items():
    op = cell_key.split('(')[0]
    inner = cell_key[len(op)+1:-1]
    parts = [p.strip() for p in inner.split(',')]
    cell_id = cell_key.replace('(', '_').replace(')', '').replace(', ', '_').replace(' ', '_')
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
               'separation': float(np.mean(intra) - np.mean(inter))}, f, indent=2)
