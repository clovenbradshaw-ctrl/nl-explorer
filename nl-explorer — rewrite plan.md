# nl-explorer — helix enforcement via wave fold dynamics
# Complete specification. Sits underneath the existing rewrite plan.
# Layer 1 filters ship as-is; this plan makes them unnecessary.

---

## The core problem

The Layer 1 quality filters (`isDisplayableEntity`, `hasPredicate`, EVA
notice strip) are a rendering-time workaround for a pipeline that runs
stages in sequence but not in dependency. Operator stages should be true
dependencies on the helix:

- **NUL → SIG → INS** — nothing becomes an entity until signal
  accumulates through the integral.
- **INS → SEG → CON** — CON edges cannot exist between non-instantiated
  anchors; co-occurrence is SIG evidence until both endpoints are INS'd.
- **CON → SYN → DEF** — DEF frames crystallize from accumulated CON
  neighborhood via coherence variance, not from a one-shot snapshot.
- **DEF → EVA → REC** — EVA must test a clause against the DEF frames
  of its entities, not classify raw clauses in isolation.

Today the main thread runs every stage against raw text.
`stageINS_threshold` fires INS on frequency count, bypassing the fold
worker's integral. `stageCON_cooccurrence` emits edges between NP
candidates whether or not they ever get INS'd. `stageFrameDEF` hashes a
neighborhood snapshot at call time. `stageEmbeddingClassify` runs EVA with
no DEF context. The fold worker already implements the helix-correct
primitives — integral crossing → INS, `pendingCons` deferral,
`drainPendingCons`, coherence variance — but it observes the log after
ingest completes, so its INS events arrive too late to gate anything.

Enforcing dependency makes the quality filters unnecessary: entities that
never cross θ_INS never appear. Structure becomes inevitable given enough
evidence, instead of emergent-by-accident and filtered at the rail.

---

## The wave fold

The wave fold is a continuous process. The integral I_e(p) at position p
in the document is the accumulated salience of entity e up to that point,
with decay:

```
dI_e/dp = σ_e(p) - λ_e(p) · I_e(p)
```

Signal arrives when e is mentioned — σ_e(p) spikes, weighted by
structural position. Subject position contributes most. Argument position
contributes moderately. Citation position contributes weakly — the
document is not foregrounding the cited string as a stable referent.
Between mentions, the integral decays at rate λ_e, modulated by the grain
boundary just crossed:

| Boundary | Decay multiplier |
|---|---|
| Clause | × 1.0 (minimal) |
| Sentence | × 0.85 |
| Paragraph | × 0.5 |
| Section | × 0.2 |

INS fires at the first crossing of θ_INS — not when count ≥ 3, but when
the integral crosses threshold, which requires sustained coherent signal
across structurally foregrounded positions, not just frequency.

**The fold operation** fires at pronouns and anaphoric references. The
accumulated integral at position p is the wave shape. When a pronoun
arrives, fold that shape back onto itself to find the peak — the most
salient compatible anchor in the working set. Confidence is the gap
between the top candidate and the second, normalized. The pronoun resolves
to the peak. Continuous accumulated state collapses to a discrete
reference assignment. That's the fold.

**Why this produces inevitability.** "Policy Analysis Indiana University
Bloomington" appears three times, all in citation position. Weak signal,
far apart, integral never crosses θ_INS. Never instantiated — not because
a filter rejected it, but because the document never treated it as a
stable referent. "Common-pool resources" appears in subject position,
gets abbreviated to "CPRs", gets pronominalized. Integral rises steeply,
crosses threshold early, stays high. `isDisplayableEntity` approximates
this distinction with token-count heuristics. The integral computes it
formally, without domain knowledge, on any document in any genre.

---

## Three NUL states from integral history

The three absence states — never-set, unknown, cleared — are formally
derivable from the integral trajectory at any position in the document.
No keyword detection required.

**Never-set:** no SIG events have ever fired for this schema slot. The
integral has no history at all.

**Unknown:** SIG events have fired and the integral has accumulated, but
it has never crossed θ_INS. The document has noticed this thing but hasn't
committed to it as a stable referent. Signal exists, just not enough to
instantiate.

**Cleared:** the integral crossed θ_INS (INS fired), but subsequent decay
without reinforcing signal has dropped it below a floor threshold. The
entity was established and has since receded. The document foregrounded it
and then moved on.

When a schema slot exists — something the document implies should be
filled, like an authorization, a disclosed amount, a named party — and the
integral for that slot is in unknown or cleared state, that's a structural
absence finding. The current NUL stage has 8 entries, all `explicit_claim`
keyword matches. The integral produces structural absences automatically.
"The authorization record's integral is in unknown state — the slot was
established but no entry ever crossed threshold" is a methodologically
grounded claim, not a pattern match.

---

## Coherence variance as the DEF crystallization signal

The fold worker already implements coherence variance. It's the right
signal for when DEF should crystallize — not "the neighborhood is stable"
(vague) but "the variance of the integral values across the neighbor set
has dropped below θ_DEF."

When an entity first gets INS'd, its neighbors are noisy — everything that
co-occurred in the early evidence. As more evidence accumulates, the
integral values for genuine structural neighbors stay high while incidental
co-occurrences decay. The variance of the neighbor integrals compresses.
When it drops below θ_DEF, the neighborhood has crystallized. DEF fires
then — not at call time, not on a snapshot.

This makes DEF timing document-relative. An entity that gets instantiated
early but whose neighborhood keeps shifting (like a highly connected hub)
takes longer to crystallize a DEF frame than an entity that gets
instantiated once and keeps appearing in the same structural context. The
threshold is the same for both; the dynamics produce different timings
from the document's own evidence.

---

## The document builds its own predicate vocabulary

The predicate vocabulary for CON — the verbs that characterize
relationships — should emerge from the document itself, not from a fixed
enum. The wave fold enables this.

When two INS'd entities keep co-occurring with the same verb between them,
that verb's integral accumulates. When the verb integral crosses threshold,
the predicate is established as part of the relationship's DEF frame. The
predicate lexicon is emergent from the document's own usage. "Transferred"
appears eight times between NDP and NDMC PSO LLC, always in the same
structural position, with high integral accumulation. It becomes the named
predicate for that relationship. A verb that appears once between two
entities and then doesn't recur decays without becoming a predicate.

`stageCON_cooccurrence` doesn't need an external predicate list. It needs
to track verb co-occurrence integrals alongside entity integrals. The H1
LLM hook for predicate extraction becomes a fallback for cases where the
integral hasn't accumulated enough to establish a predicate from the
document's own evidence — not the primary mechanism.

The relationship's DEF frame then includes the established predicates with
their integral values: "X and Y are connected via [verb1] (integral: 3.2)
and [verb2] (integral: 1.8), across [n] co-occurrences." This is richer
than a structural hash, grounded in the document's own language.

---

## Convergence as the coreference criterion

Within-document pronoun resolution folds to the peak of the current
integral. Cross-document coreference requires a stronger criterion: two
entity anchors co-refer if and only if their integral trajectories
converge as evidence accumulates.

If "NDP" and "Nashville Downtown Partnership" are the same entity, their
integral trajectories across documents should converge. The same evidence
that makes one salient makes the other salient. Their neighborhood
compositions become increasingly similar. Their DEF frames are tested by
the same EVA evidence. Convergence is the criterion.

If they're distinct, their trajectories diverge or remain parallel
regardless of how much evidence accumulates. The static structural
similarity measure — Jaccard on neighbor sets, trigram similarity,
temporal pattern matching — is a snapshot approximation of this dynamic
criterion. It's a useful early signal, but the convergence criterion is
what makes a merge decision grounded rather than heuristic.

Practically: track the rolling similarity of integral trajectories across
documents. When trajectory similarity exceeds a threshold and is stable
(its derivative approaches zero), merge the anchors. When trajectory
similarity is below threshold or diverging despite accumulated evidence,
they're distinct. The merge confidence score is the integral of the
convergence signal, not a one-time Jaccard computation.

---

## EVA calibration via integral bootstrapping

The 92% flat EVA profiles are a diagnostic signal about the relationship
between the document's domain and the centroid set — not just a display
problem.

When flat rate exceeds 60% in the first 100 clauses, use the three-
question responses from those clauses to bootstrap document-specific
pseudo-centroids. Cluster the clause embeddings by their three-question
cell assignments. Derive centroids from the clusters. These pseudo-
centroids are valid only for this document, but they're derived from the
document's own structure rather than from an external corpus that may not
match this domain.

This is the wave fold at the meta-level: the document's own evidence
accumulates into a classification instrument. After bootstrapping,
subsequent EVA classification uses the document-specific centroids.
The flat rate drops because the measurement instrument has been calibrated
to this domain. The calibration DEF entry (`classifier_mode:
flat_profile_detected`) triggers this process, not just a notice strip.

---

## The integral as audit trail

The Given-Log records what was observed, not what happened. The integral
makes this epistemically precise. At any position p, I_e(p) represents
the accumulated evidence that entity e is a stable referent, weighted by
recency and coherence. Not "entity e exists" — that's a claim about the
world. But "the document has been treating e as a stable referent up to
position p with integral value I_e(p)" — that's a claim about the text,
which is directly observable and auditable.

The audit trail report is derivable from integral trajectories over the
log. "We know the authorization record is absent because: the
authorization slot exists (its integral crossed θ_INS from the regulatory
schema), the authorization record entity's integral in the document corpus
is in unknown state (never crossed threshold despite the slot being
established), and this absence was detected at document position X with
integral value Y." That's methodologically grounded absence, not keyword
matching.

---

## What the current pipeline is doing instead

The fold worker keeps counts and structural relationships. It doesn't
maintain running integral values. It doesn't decay anything between
mentions. It doesn't have grain-boundary events that modulate the decay
rate. This is accumulation, not integration.

`stageINS_threshold`: histogram. `findVerbBetween`: heuristic substring
search. Pronoun CON entries: `confidence: 0`, `subject_text: "?"`. EVA:
labeling clauses against global centroids with no DEF context. NUL: 8
keyword matches. DEF frame values: unreadable anchor hashes.

The fold worker already has the correct machinery — integral crossing,
pendingCons deferral, coherence variance. The problem is it observes the
log after ingest, so nothing gates on its output.

---

## The three changes

### Change 1 — Remove `stageINS_threshold`; fold worker owns INS

**Delete:**
- `stageINS_threshold` at index.html:3062–3126
- Call site at index.html:3941
- Visibility count block at index.html:3942–3945

Stream new log entries to the fold worker as they are pushed during
ingest, not after. After each `stageSIG_*` call (lines 3924–3926),
iterate entries since a high-water mark and `await appendToLog(entry)`
for each. No change to `OperatorLog`.

Add a crystallization barrier between SIG and CON in `ingest()`:

```javascript
await workerRequest(workerBridge.foldWorker, 'flush', {});
const entityAnchors = await workerRequest(
  workerBridge.foldWorker, 'get_entity_anchors', { doc_anchor: da }
);
```

The returned map has the same `{ normalized: anchor }` shape downstream
stages expect, but sourced exclusively from integral crossings in
`foldSIG` (fold-worker.js:398–421).

**Fold worker additions:**
- `get_entity_anchors` handler: return `M.entities` filtered by
  `doc_anchor`, with `normalized` field stored at INS time in `foldINS`
  (lines 131–155).
- Extend main-thread `fold_event` handler (index.html:4730): INS/DEF
  events emitted by the worker must also push into the live log object —
  downstream stages iterate `log.entries()` and must see them.
- Reconcile `COREF_CONFIG.ins_threshold` (currently 4.0 at
  fold-worker.js:27) with the old count floor of 3 before deletion. Tune
  via telemetry; expose via `COREF_CONFIG_UPDATE`.

**Integral dynamics to wire (fold-worker.js):**

On each SIG event: add σ (weighted by structural position — subject × 1.0,
argument × 0.6, citation × 0.15) to I_e.

On each SEG event: apply decay multiplier to all live integrals per the
boundary table above. Entities with I_e below floor threshold move to
background state — still in M, not in the active working set.

On INS crossing: fire INS entry, store `normalized` field, add to
`get_entity_anchors` response set.

**NUL state assignment (fold-worker.js):** When processing a schema slot
that hasn't been filled, assign NUL state from integral history:
- No SIG history for this slot → `never-set`
- SIG history present, never crossed θ_INS → `unknown`
- Crossed θ_INS then decayed below floor → `cleared`

Emit structured NUL entries with state, integral value at detection, and
position. The main-thread keyword-match NUL stage becomes a secondary
signal only.

### Change 2 — Gate `stageCON_cooccurrence` on INS state; verb integral tracking

`stageCON_cooccurrence` (index.html:3198–3247) keeps its signature. The
gate is implicit once `entityAnchors` is the worker-returned INS'd set.
The union regex only matches canonicals that crossed θ_INS — no CON edge
can be emitted between non-INS'd anchors.

For co-occurrences involving pre-INS candidates: emit SIG with
`detector: 'COOC_EVIDENCE'` that feeds the candidate's integral. Fetch
candidate surface forms via new worker op `get_candidate_anchors`. Route
matches to SIG instead of CON until both endpoints are INS'd.

**Verb integral tracking (fold-worker.js):** Alongside entity integrals,
maintain verb integrals per entity pair. When two INS'd entities
co-occur with a verb V between them, increment I_{V,e1,e2}. When this
integral crosses a predicate threshold, the verb is established as a
named predicate for the relationship and included in the next DEF frame
crystallization. The predicate vocabulary is discovered from the
document's own structural patterns.

The existing `pendingCons` / `drainPendingCons` machinery
(fold-worker.js:210–230) becomes a backstop — most premature CONs are now
prevented at emission time.

**Pronoun fold (fold-worker.js):** When a pronoun SIG arrives, read the
current working set ordered by integral value (not recency). Filter by
grammatical compatibility. Top compatible entity by integral value is the
resolution candidate. Confidence = normalized gap between top and second
candidate. Return NUL state if working set is empty — assign `unknown`
(SIG accumulated but no INS yet), `cleared` (INS'd entity decayed), or
`never-set` (no compatible entity in any grain) accordingly.

### Change 3 — DEF crystallizes via coherence variance; EVA receives DEF context and integral values

**Migrate `stageFrameDEF`** (index.html:3294–3340, plus `buildFrameLabel`
at 3278–3292 and `neighborSet` helper) into fold worker function
`crystallizeFrames(doc_anchor)`.

The crystallization trigger is coherence variance dropping below θ_DEF —
not a call-time snapshot. `crystallizeFrames` reads `M.entities`,
`M.conEdges`, verb integrals, and current integral values. For each
INS'd entity whose coherence variance has crossed the threshold since the
last crystallization, emit a DEF entry via local `fold(defEntry)`.

The DEF frame includes:
- `neighbor_set` with integral values per neighbor (not just anchors)
- `established_predicates` from verb integrals above predicate threshold
- `coherence_variance` at crystallization time
- `frame_label` in readable form

Replace the main-thread call at index.html:3977:

```javascript
await workerRequest(foldWorker, 'crystallize_frames', { doc_anchor: da });
```

**EVA with DEF context (index.html:3671–3741):** Before `classifyClauses`
at line 3683:

```javascript
const frames = await workerRequest(foldWorker, 'get_all_frames', { doc_anchor: da });
const integrals = await workerRequest(foldWorker, 'get_integrals', { doc_anchor: da });
```

For each clause, find entity anchors present in the clause text via the
union regex. Attach `{ text, entities, frames, integrals }` to the
classifier input.

Extend `window.EOClassifier.classifyClauses` to produce a second EVA
entry per clause with `eva_type: 'frame_test'`. For each entity in the
clause with an established DEF frame:
- Compare the clause embedding against the frame's neighbor-set centroid
- Weight the comparison by the entity's current integral value (highly
  salient entities contribute more to the EVA result)
- Produce result in `{satisfies, extends, contracts, conflicts}`

The existing 27-cell classification still runs and answers "what kind of
transformation." The frame test answers "does this evidence reshape the
frame." Together they produce: "this clause is a CON-type event that
extends the frame of common-pool resources."

**EVA calibration bootstrapping:** In `stageEmbeddingClassify`, after
first 100 clause results: if flat rate > 60%, run three-question
classification on those clauses, cluster their embeddings by cell
assignment, derive document-specific pseudo-centroids, and use them for
all subsequent EVA classification in this document. Log the bootstrapping
as a DEF entry: `param: 'classifier_mode', value: 'domain_bootstrapped'`.
The flat-rate advisory strip still appears — now it also reports the
bootstrapping result.

**Cross-document coreference via trajectory convergence (fold-worker.js):**
When `stageSIM_candidates` runs across multiple documents, compute
trajectory similarity as the rolling similarity of integral values over
shared evidence positions, not a one-time Jaccard score. Two anchors are
merge candidates when their trajectory similarity exceeds threshold AND
is stable (derivative near zero). Two anchors are confirmed distinct when
trajectory similarity is diverging despite accumulated evidence. Upgrade
the existing Jaccard/trigram structural similarity to feed into the
trajectory computation rather than replace it.

---

## Synchronization protocol

**New worker ops:**

| Op | Input | Output |
|---|---|---|
| `get_entity_anchors` | `{ doc_anchor }` | `{ [normalized]: anchor }` |
| `get_candidate_anchors` | `{ doc_anchor }` | `{ [normalized]: { anchor, integral, sig_count } }` |
| `crystallize_frames` | `{ doc_anchor }` | `{ emitted: n }` |
| `get_all_frames` | `{ doc_anchor }` | `{ [anchor]: frame }` |
| `get_integrals` | `{ doc_anchor }` | `{ [anchor]: integral_value }` |

`flush` must guarantee all queued BroadcastChannel `new_entry` messages
are folded before resolving — add a microtask barrier if needed.

**Sequenced chain in `ingest()`:**

```
SIG_NPs + pronouns + reframe
  → flush → get_entity_anchors
  → stageINS_definitions → stageCON_cooccurrence → stageSPO → stageSYN
  → flush → crystallize_frames
  → flush → get_all_frames + get_integrals → stageEmbeddingClassify
  → stageEVA_temporal → stageNUL
```

---

## Critical files

| File | Locations |
|---|---|
| `index.html` | `ingest()` at 3895; `stageINS_threshold` at 3062; `stageCON_cooccurrence` at 3198; `stageFrameDEF` at 3294; `stageEmbeddingClassify` at 3671; worker bridge at 4693–4770 |
| `workers/fold-worker.js` | `foldSIG` integral crossing at 297–421; `foldCON` deferral at 197–230; `foldINS` at 122–175; coherence variance (existing); `onmessage` switch (add new ops); `COREF_CONFIG.ins_threshold` at 27 |
| EO classifier | `window.EOClassifier.classifyClauses` — extend to accept `entities`, `frames`, `integrals`; emit `frame_test` EVA |

---

## Code that becomes deletable after helix lands

- `stageINS_threshold` (~65 LOC, index.html:3062–3126)
- Main-thread `stageFrameDEF`, `buildFrameLabel`, `neighborSet` (~80 LOC,
  index.html:3278–3340)
- `isDisplayableEntity` and all call sites — keep as no-op shim until
  telemetry confirms integral threshold gates at the quality boundary
- Keyword-match NUL stage (8 entries) — replaced by structural NUL from
  integral history
- Post-ingest bulk drain loop (index.html:5509–5511) — replaced by
  streaming emit

---

## Verification

End-to-end on OstromPolyGov (382 bad entities, 6,962 predicate-less CONs,
978 flat-profile EVAs, 8 keyword NULs):

**Structural correctness:**

1. `M.entities.size` far smaller than 382; no citation strings, figure
   labels, or pure stopword nouns — with `isDisplayableEntity` disabled.

2. CON graph contains no edges where either endpoint has no entry in
   `M.entities`.

3. Every DEF frame in `M.defFrames` emitted by the worker, not main
   thread. Every DEF frame includes `coherence_variance` at
   crystallization time.

4. Toggle `isDisplayableEntity` to always-true. Entity counts unchanged.
   The helix is doing what the filter used to do.

**Integral dynamics are genuinely running:**

5. `M.entities` contains running integral values per entity. Values vary:
   high for foregrounded entities (common-pool resources, polycentric
   governance), low for backgrounded ones. Not a flat distribution.

6. Entities appearing only in citation position have lower final integral
   values than entities appearing in subject position across multiple
   sections.

7. NUL entries are classified as never-set / unknown / cleared based on
   integral history, not keyword matching. At least some schema-slot
   absences are detected structurally.

8. DEF crystallization timestamps correlate with coherence variance
   drops — early for stable entities, later for high-churn hubs.

9. Pronoun resolution confidence scores vary across the document: higher
   where fewer compatible anchors are in the working set, lower where the
   working set is dense. This is the fold producing genuine signal.

10. EVA `frame_test` entries reference real anchors in `M.defFrames`.
    Results are non-null and vary (not all `satisfies`). Highly salient
    entities contribute more to EVA results than backgrounded ones.

**EVA calibration:**

11. Run calibration check. If flat rate > 60%, confirm document-specific
    pseudo-centroids were bootstrapped and subsequent EVA entries show
    lower flat rate than the first 100.

**Log composition shift:**

12. SIG count rises (co-occurrence evidence is now SIG).
    CON count drops (only INS'd pairs).
    INS count equals `M.entities.size`.
    DEF(frame) count equals INS count.
    NUL count rises (structural absences detected, not just keyword matches).
