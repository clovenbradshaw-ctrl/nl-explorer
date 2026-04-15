LLM Integration — Build Instructions
The helix is a dependency graph, not a pipeline
Before touching a line of code, understand what the build enforces and why.

The nine operators are ordered:

NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC

This ordering is not about sequence. It is about what must exist before
something else can be legitimately said. Every claim you want to make about
a target requires that target to have been established at every helix level
below the claim.

If you want to define what something is (DEF), it must first exist (INS),
have a boundary (SEG), and sit in a structural neighborhood (CON). If you
want to evaluate a frame (EVA), the frame must first exist (DEF). If you
want to restructure a frame (REC), something must have tested and broken it
(EVA). You cannot skip levels. Skipping levels produces a claim that floats
above its evidence.

The topological sort in buildReportDAG enforces this. For any node N with
target T, every node that established T at a lower helix level must appear
before N in the sorted order. The LLM paraphrases in that order. It can only
speak about what something means after the log has established what it is.

What the DAG tells you about a corpus:

When you sort the log and inspect the order, violations of the helix
dependency become visible as structural findings:

An EVA node whose target has no prior DEF is a claim about meaning with no
established frame. The claim is floating — asserting evaluation without
a frame to evaluate against.
A DEF node whose target has no prior INS is a definition of something that
doesn't exist in this corpus yet. The entity was named before it was
observed.
A REC node whose target has no prior EVA means frame restructuring with
nothing to restructure from. The urgency is claimed but not evidenced.
A CON edge where either endpoint has no INS is a relationship between
non-entities. The connection is asserted but neither side is real yet.
These are not errors to silently fix. They are the most interesting parts of
the corpus — the places where claims exceed evidence. The DAG makes them
visible. Cycles in the DAG — two nodes that each depend on the other — are
a specific case: circular grounding, where X is interpreted through Y and Y
through X, neither independently established. In an investigation corpus this
is a finding about mutually reinforcing claims with no independent anchor.
Record them explicitly rather than resolving them silently.

App actions are operator firings
This is the insight from EO///DB that connects the architecture to the
framework.

In EO///DB we noticed that targeting an entity in the interface is itself a
form of SEG. When you click on an entity and the system draws a selection
around it, that is not a UI event that triggers a query — that IS the SEG
operator firing. The app's action and the operator are the same event.

This generalizes across every interaction in the explorer:

App action	Operator
A token appears in text	NUL — this position exists; nothing distinguished yet
NP extractor notices a phrase	SIG — something became distinguishable
Hovering a span	SIG — attention registered, not committed
Reading a span (dwell triggers embedding)	INS — entity instantiated as a referenceable particular
Selecting a span range / annotating a boundary	SEG — a boundary is drawn
Linking two entities in the inspector	CON — directed connection between instantiated entities
System detecting a cluster across documents	SYN — irreducible composite; neither document contains it alone
User naming or defining an entity	DEF — a frame is established
EVA pressure score updating on new evidence	EVA — current frame is being tested
Conflict threshold crossed, REC surfaced	EVA forcing REC — frame found wanting
User supplies new frame for REC candidate	REC — frame restructured
The four LLM hooks sit at exactly the helix positions where the mechanical
pipeline's capacity is exhausted.

Below SEG — the entire Existence triad — the mechanical pipeline does the
work directly. Token extraction, NP detection, co-occurrence: measurements,
not readings. The LLM adds nothing here and is never called.

At CON, the mechanical pipeline finds co-occurrence but cannot determine
direction or predicate type. That requires reading subject-agent structure —
a Structure-level act. H1 fires here.

At DEF, the mechanical pipeline produces a structural fingerprint but cannot
name what kind of thing the entity is. That is the transition into
Significance. H2 fires here.

At EVA, the embedding measures similarity to 27 centroids. When the profile
is flat — the top two cells nearly equal — the measurement is genuinely
ambiguous. A second reader from a different mechanism is warranted. H3 fires
here, using the three-question decomposition.

At REC, a frame has been flagged as requiring restructuring. The LLM is asked
not to produce the restructuring but to suggest which restructuring path to
take from a fixed vocabulary. H4 fires here.

The three-question approach for H3
H3 uses three questions instead of asking the LLM to select from 27 cell IDs.

The 27 cells are addresses in a three-dimensional space. Each is exactly the
intersection of one answer from each of three independent questions —
one per axis of the capacity ground:

Q1 — Mode:    A) Differentiating   B) Relating   C) Generating
Q2 — Domain:  A) Existence         B) Structure  C) Significance
Q3 — Object:  A) Background        B) Entity     C) Pattern

Asking for a cell ID requires the LLM to navigate a 27-position space it has
no training on. Asking the three questions requires it to make three visible,
auditable decisions about the text in front of it. The answers are three
letters. The cell is derived deterministically from a 27-row lookup table.
The LLM never generates a cell ID.

Validation is trivial: valid answers are exactly the strings drawn from
{A,B,C}³. Any other output fails immediately.

The disagreement is informative: when the three-question output disagrees
with the embedding's top cell, you learn which axis is uncertain. If Q1
disagrees but Q2 and Q3 agree, the Mode axis is uncertain — both readers
agree on domain and object type but disagree on whether the transformation
is differentiating, relating, or generating. If Q3 disagrees while Q1 and Q2
agree, the Object axis is uncertain — both readers agree on the operator but
disagree on the kind of target. This axis-level finding feeds directly into
the exemplar corpus: add examples at this mode/domain intersection, because
the centroid there is underspecified for this domain's vocabulary.

Complete lookup table:

Q1 × Q2 → operator      Q1 × Q3 → resolution        Q2 × Q3 → site
AA = NUL                 AA = Clearing               AA = Void
AB = SEG                 AB = Dissecting             AB = Entity
AC = EVA                 AC = Unraveling             AC = Kind
BA = SIG                 BA = Tending                BA = Field
BB = CON                 BB = Binding                BB = Link
BC = DEF                 BC = Tracing                BC = Network
CA = INS                 CA = Cultivating            CA = Atmosphere
CB = SYN                 CB = Making                 CB = Lens
CC = REC                 CC = Composing              CC = Paradigm

cell_id = operator(resolution, site)

BAB → SIG(Binding, Entity)       [frequent in investigation corpora]
CAB → INS(Making, Entity)        [the gravity well — most populated cell]
BCA → DEF(Tending, Atmosphere)   [frame-setting for ambient entities]
CCB → REC(Making, Lens)          [reframing how something is read]
AAA → NUL(Clearing, Void)        [the deep desert — nearly empty]

Build instructions
Everything goes in /home/user/nl-explorer/index.html. One CSS block, one
HTML block, one script insertion, and four two-line hook additions to
existing pipeline stages. workers/log-worker.js is not touched.

Step 1 — CSS (line 535)
Inside the existing <style> tag:

.report-sentence  { font-size:13px; line-height:1.6; color:var(--bright); }
.report-citation  { font-size:10px; font-family:'JetBrains Mono',monospace;
                    color:var(--def); text-decoration:underline; cursor:pointer; }
.report-eva-table { width:100%; border-collapse:collapse; font-size:11px;
                    font-family:'JetBrains Mono',monospace; margin:6px 0; }
.report-eva-table td        { padding:2px 6px; border:1px solid var(--border); }
.report-eva-table .top-cell { background:rgba(34,211,238,.1); color:var(--def); }
.report-fallback  { color:var(--muted); font-style:italic; font-size:11px; }
.report-section   { margin:14px 0; padding:10px 14px;
                    border-left:2px solid var(--border2); }
.report-section h3 { font-size:11px; color:var(--muted); letter-spacing:.08em;
                     text-transform:uppercase; margin-bottom:6px; }
#report-dialog    { background:var(--surface); border:1px solid var(--border2);
                    border-radius:6px; padding:20px; max-width:540px; width:100%;
                    color:var(--text); }
#report-dialog::backdrop { background:rgba(0,0,0,.6); }
.rdlg-row         { display:flex; gap:8px; margin-bottom:10px; align-items:center; }
.rdlg-row label   { font-size:11px; color:var(--muted); min-width:90px; }
.rdlg-progress    { font-size:11px; color:var(--sig);
                    font-family:'JetBrains Mono',monospace; }
.rdlg-output      { max-height:300px; overflow-y:auto; padding:10px;
                    background:var(--bg); border:1px solid var(--border);
                    border-radius:4px; font-size:12px; line-height:1.7; }

Step 2 — HTML: Report button and dialog (line 1081)
After <button id="btn-download" ...>↓ NDJSON</button>:

<button onclick="openReportDialog()" id="btn-report" style="display:none">
  ◎ Report
</button>

<dialog id="report-dialog">
  <div style="font-size:14px;font-weight:700;margin-bottom:14px;">
    Generate report
  </div>

  <div class="rdlg-row">
    <label>API key</label>
    <input id="rdlg-key" type="password" placeholder="sk-ant-…"
           style="flex:1;font-family:monospace;font-size:11px;"
           oninput="localStorage.setItem('eo_anthropic_key',this.value)">
    <label style="min-width:auto">
      <input type="checkbox" id="rdlg-session" onchange="handleSessionOnly(this)">
      session only
    </label>
  </div>

  <div class="rdlg-row">
    <label>Model</label>
    <select id="rdlg-model" style="flex:1;">
      <option value="claude-haiku-4-5-20251001">Claude Haiku (cheapest)</option>
      <option value="claude-sonnet-4-6">Claude Sonnet</option>
    </select>
  </div>

  <div class="rdlg-row">
    <label>Mid-flow hooks</label>
    <input type="checkbox" id="rdlg-midflow">
    <span style="font-size:11px;color:var(--muted);">
      H1 CON direction · H2 DEF frame · H3 EVA tiebreak · H4 REC suggestion
    </span>
  </div>

  <div class="rdlg-row">
    <label>Trust LLM entries</label>
    <input type="checkbox" id="rdlg-trust">
    <span style="font-size:11px;color:var(--muted);">
      let downstream stages consume LLM CON/DEF entries
      (off = mechanical chain authoritative)
    </span>
  </div>

  <div class="rdlg-row" id="rdlg-progress-row" style="display:none;">
    <label>Progress</label>
    <span class="rdlg-progress" id="rdlg-progress">—</span>
  </div>

  <div class="rdlg-output" id="rdlg-output" style="display:none;"></div>

  <div style="display:flex;gap:8px;margin-top:14px;">
    <button id="rdlg-generate" onclick="runReport()">Generate ▶</button>
    <button id="rdlg-cancel" onclick="cancelReport()" style="display:none;">
      Cancel ✕
    </button>
    <button onclick="document.getElementById('report-dialog').close()">Close</button>
    <button id="rdlg-export" onclick="exportReport()" style="display:none;">
      ↓ Markdown
    </button>
  </div>
</dialog>

Step 3 — Script insertion (line 4220)
Paste the entire contents of llm-layer.js as a new <script> block
immediately before </body>. It uses makeEntry, anchor,
resolveDisplayName, getStopSet, escapeHtml, and state by
reference — all already in scope.

Step 4 — Show Report button after ingest (line 4635)
In renderAll(), add one line at the end:

function renderAll() {
  renderTabs();
  renderLog();
  renderStats();
  document.getElementById('btn-download').style.display = 'inline';
  maybeShowReportButton();   // ← add this
}

Step 5 — H1: CON direction (line 3098)
After log.push(makeEntry('CON', ...)) in stageSPO for heuristic triples:

if (getLLMConfig().enableMidFlow) {
  hookH1_CON(
    log,
    log.entries().at(-1),   // the just-pushed mechanical CON
    sent.text,              // the sentence that generated it
    entityAnchors,          // NP→anchor map for this document
    _reportAbort?.signal
  ).catch(() => {});
}

Fires only when the mechanical CON confidence is below 0.65. Emits a new
CON with operand.predicate typed and direction corrected. Never mutates
the mechanical entry.

Step 6 — H2: DEF frame candidate (line 3322)
After log.push(makeEntry('DEF', ...)) in stageFrameDEF:

if (getLLMConfig().enableMidFlow) {
  const lastDef = log.entries().at(-1);
  hookH2_DEF(
    log,
    lastDef,
    docText.slice(
      lastDef.provenance?.span_start ?? 0,
      (lastDef.provenance?.span_end ?? 0) + 200
    ),
    _reportAbort?.signal
  ).catch(() => {});
}

Fires only when DEF frame confidence is below 0.70. Emits a new DEF with
operand.kind: 'frame_candidate' and a label from the fixed vocabulary.

Step 7 — H3: EVA tiebreak, three questions (line 3243)
After log.push(makeEntry('EVA', ...)) in stageEmbeddingClassify:

if (getLLMConfig().enableMidFlow) {
  hookH3_EVA(
    log,
    log.entries().at(-1),     // the just-pushed EVA entry
    clauseEntry.operand?.text ?? spanText ?? '',
    _reportAbort?.signal
  ).catch(() => {});
}

Fires only when the similarity profile margin (top-1 minus top-2) is below
0.08. Sends the three-question prompt, validates the three-letter answer,
derives the cell deterministically, emits a new EVA with the tiebreak
result. When the derived cell disagrees with the mechanical top cell, also
emits a NUL boundary-finding entry with operand.disputed_axis identifying
which axis is uncertain. That entry is flagged for the exemplar corpus.

Step 8 — H4: REC suggestion (line 3337)
After combinedLog.push(makeEntry('REC', ...)) where
resolution: 'pending_human' in stageREC_superposition:

if (getLLMConfig().enableMidFlow) {
  hookH4_REC(
    combinedLog,
    combinedLog.entries().at(-1),
    _reportAbort?.signal
  ).catch(() => {});
}

Emits a new REC with operand.kind: 'h4_suggestion' and one of the six
fixed resolution paths: accept_boundary, domain_mapping,
flag_for_corpus, split_entity, merge_entity, reframe_temporal.

Verification sequence
Run from the browser console after loading. All helpers are on
window._eoVerify.

First — confirm the three-question prompt works:

await _eoVerify.testThreeQ(
  "The organization failed to disclose the allocation."
)
// Returns raw LLM output, validated three letters, and derived cell_id.
// If this fails with no_api_key, the dialog key input is not persisting.

After ingest with mid-flow OFF — confirm zero LLM entries:

_eoVerify.t6()
// PASS: zero source:'llm:claude' entries, all mechanical entries present.

After generating a report:

_eoVerify.t1()  // no fabricated anchors or names in any paraphrase
_eoVerify.t2()  // every paraphrase emitted after its target
_eoVerify.t3()  // get dag_order_hash — note it for round-trip test

Round-trip (manual):

_eoVerify.t3() — note the hash
Download NDJSON, reload the page, re-import
_eoVerify.t3() — hash must match
Generate a second report — new report_run_id, prior paraphrases intact
After ingest with mid-flow ON:

_eoVerify.t7()
// PASS: every LLM entry's trigger_anchor resolves to a mechanical entry
// with earlier timestamp; validator_passes true or NUL failure entry present.

Mutation resistance (optional but worth running once):

// Intercept Anthropic API calls to return a fabricated response
const origFetch = window.fetch;
window.fetch = (...args) => {
  if (args[0]?.includes?.('anthropic')) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({
      content: [{ text: 'John Smith invented this in 1999 [log_id:@deadbeef000000].' }]
    })});
  }
  return origFetch(...args);
};
// Generate a report — every node should render the deterministic fallback.
// Restore: window.fetch = origFetch;

What stays unchanged
workers/log-worker.js — untouched. The append path at line 98 is the only
write path.

ingest() — untouched. All four hooks are async and non-blocking. Ingest
completes before any LLM entry arrives. Late entries are legal because the
log is append-only.

OPFS layer, fold worker, M state — unchanged. LLM entries arrive via the
same append path as mechanical entries and fold identically.
provenance.source: 'llm:claude' distinguishes them on replay.

stageSPO_llm at line 4137 — H1 replaces its internal fetch with
hookH1_CON through the shared queue. Gate conditions unchanged.

The 27-cell centroid UI and centroids.json — unchanged. H3 reads
similarity_profile from EVA entries the existing classifier produces.
The three-question prompt adds a second reading; it does not replace the
centroid measurement.
