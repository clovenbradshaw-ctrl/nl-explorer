# nl-explorer

A standalone, static, browser-based natural language explorer that parses
documents into an **EO operator log** (INS / SEG / SIG / CON / EVA / NUL /
DEF / REC) and classifies each clause into one of 27 semantic cells using an
in-browser embedding model compared against pre-computed centroids.

Extracted from the [`nl/` folder of clovenbradshaw-ctrl/EO-DB](https://github.com/clovenbradshaw-ctrl/EO-DB/tree/main/nl)
and repackaged as a self-contained repo.

## Run it

Everything is static. Open `index.html` in any modern browser, or serve the
directory:

```bash
python3 -m http.server 8000
# then browse to http://localhost:8000/
```

Or publish via GitHub Pages — this repo is shaped so the default branch root
works directly as a Pages site.

### First-time classifier load

On first load the page:

1. Downloads the quantized `Xenova/all-MiniLM-L6-v2` model (~25 MB) from the
   jsDelivr CDN via `@xenova/transformers` and caches it in IndexedDB.
2. Fetches `centroids.json` from this directory. If it's missing or the user
   clicks **⚙ Bake centroids**, the page will fetch the upstream exemplars
   corpus, embed the top-N clauses per cell, and write a fresh
   `centroids.json` to OPFS (downloadable via the **↓ centroids.json**
   button).

Non-Latin scripts lazy-load the multilingual model
(`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, ~118 MB) on demand.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app — UI, ingest pipeline, embedding classifier, OPFS cache. Open this. |
| `centroids.json` | Pre-baked centroid vectors (one record per semantic cell). Checked in so visitors don't have to bake. |
| `generate_centroids.py` | Offline pipeline that produces `centroids.json` + `alignment_matrix.json` from an `exemplars.json` corpus. |
| `docs/build.md` | Full technical spec — DEF→EVA→REC continuous-improvement architecture, invariants, falsifiability. |

## Regenerating centroids offline

```bash
pip install sentence-transformers numpy scipy torch
python3 generate_centroids.py [path/to/exemplars.json]
```

Without an argument the script looks in the usual places and, failing that,
downloads the canonical corpus from
`clovenbradshaw-ctrl/eo-lexical-analysis-2.0`. Outputs `centroids.json`,
`alignment_matrix.json`, and `centroid_stats.json` in the current directory.

## External dependencies (loaded from CDN)

- `@xenova/transformers@2.17.2` (jsDelivr)
- `pdf.js` 3.11.174 (cdnjs) — PDF ingest
- `mammoth` 1.6.0 (cdnjs) — DOCX ingest
- Google Fonts: JetBrains Mono, Syne

No build step, no server, no install required to run.

## Proposition-reading pipeline (opt-in)

The rewrite plan in `nl-explorer — rewrite plan.md` extends the
architecture from entity-level to proposition-level tracking — adding
proposition anchors (`@p:`), predicate-slot anchors (`@ps:`), a
six-member Resolution-face CON family
(Binding / Tracing / Tending / Clearing / Dissecting / Unraveling),
per-slot predicate-class DEF crystallization, and
Cultivating-without-Making NUL tracking.

The mechanical foundations land in `workers/fold-worker.js` (M-state
additions, `foldCONTyped` dispatcher, `crystallizeSlots`) and the new
pipeline stages (`stageCON_typed`, `stageSPO_from_binding`,
`stageEVA_proposition`, `stageNUL_structural`) ship in `index.html`.
They run only when the feature flag is enabled:

```js
window.EO_PROPOSITION_READING = true;
```

With the flag off (the default) the legacy co-occurrence CON +
heuristic SPO path is preserved unchanged. With the flag on, every
clause is classified by Resolution stance and only Binding clauses
receive the expensive SPO + modifier extraction (plan §9 budget gate).

## Key invariants

- The 27 centroids never change at runtime.
- Every classification stores its full 27-cell similarity profile — the
  auditable evidence chain. The classification is a geometric measurement,
  not an assertion.
- Mechanical and embedding signals are stored independently.
- Non-English classifications are flagged, not suppressed.

See `docs/build.md` for the full specification.

## Provenance

Sourced from `clovenbradshaw-ctrl/EO-DB` at `main/nl/` and repackaged
verbatim (HTML renamed `natural_language.html` → `index.html`; no code
changes). Original spec © its authors.
