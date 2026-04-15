# Integral Coreference — Design Specification

**System:** nl-explorer / EO///DB ingest pipeline  
**Status:** Design — not yet implemented  
**Replaces:** Static mention-pair coref in current `stageCoref` / `stageSPO`  
**Depends on:** Append-only G log, fold worker (OPFS), per-grain span queues  

---

## 1. Conceptual model

### 1.1 The integral as entity state

Every candidate entity maintains a running integral over the discourse. The
integral is not a count of mentions. It is the accumulated, weighted, decaying
evidence that this entity exists and is being referred to at the current
reading position.

```
I_e(p) = ∫₀ᵖ σ_e(t) · w(p, t) dt
```

Where:
- `p` is current reading position (character offset, clause index, or document
  position — depends on grain)
- `t` is the position of a prior SIG event for candidate entity `e`
- `σ_e(t)` is the signal strength of that SIG event (confidence that mention t
  refers to e, 0–1)
- `w(p, t)` is a recency weight that decays with distance from p to t,
  modulated by intervening SEG boundaries

The differential form makes the dynamics explicit:

```
dI_e/dp = σ_e(p) - λ_e(p) · I_e(p)
```

- First term: incoming signal from new SIG events at position p
- Second term: decay, where λ_e(p) is the current decay rate for entity e

λ_e(p) is not constant. It increases at SEG boundaries (paragraphs, sections,
document breaks) and decreases when an entity is actively foregrounded. This
produces natural working-set dynamics: entities mentioned recently have high
integrals; entities that haven't appeared since the last section boundary have
decayed.

### 1.2 Phase transitions and EO entity types

The integral maps directly onto EO's three entity types:

| Integral state | EO type | Behavior |
|---|---|---|
| `I_e < θ_candidate` | pre-candidate | No log entry. Evidence too weak to track. |
| `θ_candidate ≤ I_e < θ_INS` | Emanon | SIG events accumulated. No anchor yet. Resists individuation. |
| `I_e ≥ θ_INS` (first crossing) | Protogon → Holon | **INS fires.** Entity has an anchor. Becomes referenceable. |
| INS'd + coherence stable | Holon | Self-governing. Maintains through discourse. |
| INS'd + coherence dropping | Protogon (bifurcation warning) | May be two entities. DEF/EVA cycle needed. |
| INS'd + integral decayed post-mention | Cleared NUL | Was active. Has faded. |

The three NUL states are integral histories, not database nulls:

- **Never-set**: no SIG events for this slot have ever fired. No integral exists.
- **Unknown**: SIG events fired, candidate integral started, never crossed θ_INS.
- **Cleared**: INS fired, entity was active, integral subsequently decayed to
  near-zero through prolonged absence.

### 1.3 App actions are operator firings

Every user and system action in the explorer fires an operator:

| Action | Operator | Effect on integral |
|---|---|---|
| NP extractor notices phrase | SIG | dI: adds signal element to candidate integrals |
| Hover a span | SIG (weak) | Small dI on the hovered entity |
| Click a span (focus begins) | SIG (strong) | Larger dI; may bring candidate above threshold |
| Dwell triggers embedding | INS | If integral ≥ θ_INS, anchor is assigned |
| Annotate a boundary | SEG | λ increases for all non-foregrounded entities |
| Link two entities | CON | Both integrals receive coherence boost |
| System detects cluster | SYN | New composite entity; integrals of component entities feed it |
| User names/defines entity | DEF | Frame anchors the integral; subsequent resolution uses frame compatibility |
| EVA pressure updates | EVA | Coherence score tested against frame; bifurcation or merge flagged |
| User resolves REC candidate | REC | Integral merge or split; G log updated |

This means the integral is not just computed at ingest time. It is updated
live as the user reads. The reading session itself is a sequence of operator
firings that modify entity state.

---

## 2. Data structures

### 2.1 Candidate registry (M state, per document anchor)

Held in the fold worker. Not persisted until INS fires.

```typescript
interface CandidateEntity {
  candidate_id:          string;           // temporary, pre-INS
  integral_value:        number;           // I_e(p), current
  accumulated_embedding: Float32Array;     // running centroid, 384-dim
  embedding_count:       number;           // for Welford online mean
  coherence_score:       number;           // 1 - variance/max_variance, 0–1
  last_sig_position:     number;           // character offset of last SIG
  last_sig_ts:           string;           // ISO timestamp
  sig_count:             number;           // total SIG events folded in
  surface_forms:         string[];         // all surface strings seen
  grain_values: {
    token:      number;
    clause:     number;
    sentence:   number;
    paragraph:  number;
    section:    number;
    document:   number;
  };
  nul_state:            'never_set' | 'unknown' | 'active' | 'cleared';
  bifurcation_warning:  boolean;
  doc_anchor:           string;
}
```

After INS fires, this entry is promoted to a full entity in M with an anchor
assigned. The candidate_id is replaced by the permanent anchor. Prior SIG
events in G that referenced the candidate_id are not mutated — the fold
worker maintains a candidate_id → anchor mapping for provenance resolution.

### 2.2 Per-grain working set queues

The working set for each grain is the subset of active entities whose
grain-appropriate integral is above the working-set threshold `θ_ws`. These
are the entities available for pronoun resolution at that grain.

```typescript
type GrainQueue = Map<anchor_string, {
  integral_value:  number;
  last_position:   number;
  display_name:    string;
  type_embedding:  Float32Array;   // lightweight type signature for fast compat
}>;

interface WorkingSets {
  token:      GrainQueue;
  clause:     GrainQueue;
  sentence:   GrainQueue;
  paragraph:  GrainQueue;
  section:    GrainQueue;
  document:   GrainQueue;
}
```

Queue updates happen at every SEG event. The fold worker maintains these in
memory and does not write them to OPFS on every update — only on checkpoint.

### 2.3 Integral event log (G entries)

These are the differential elements — each is appended to G, never mutated.

```typescript
// SIG: a mention that may belong to a candidate entity
interface SIGEntry {
  op:     'SIG';
  anchor: string;           // sig:doc_anchor:position_hash
  target: string;           // candidate_id (pre-INS) or anchor (post-INS)
  operand: {
    surface_form:    string;
    position:        number;
    span_start:      number;
    span_end:        number;
    embedding:       number[];      // 384-dim, stored as quantized int8 if persistVectors
    signal_strength: number;        // σ_e(t), 0–1
    grain:           GrainLevel;
    detector:        'NP_EXTRACTOR' | 'PRONOUN' | 'ABBREVIATION' | 'FOCUS' | 'LLM';
    resolution_confidence: number;  // how confident the fold is in this assignment
  };
  provenance: StandardProvenance;
}

// INS: integral threshold crossing — entity crystalizes
interface INSEntry {
  op:     'INS';
  anchor: string;           // permanent entity anchor, assigned at threshold crossing
  target: string;           // doc_anchor
  operand: {
    display_name:         string;
    type:                 'ORG' | 'PERSON' | 'EVENT' | 'PLACE' | 'CONCEPT' | '?';
    integral_at_ins:      number;   // I_e value when threshold crossed
    coherence_at_ins:     number;   // coherence score at INS
    sig_count_at_ins:     number;   // how many SIG events contributed
    accumulated_embedding: number[]; // centroid at INS moment
    candidate_id:         string;   // the pre-INS candidate_id this replaces
    grain:                GrainLevel;
    nul_state_prior:      'unknown';  // always unknown just before INS
  };
  provenance: StandardProvenance;
}

// SEG: boundary event — modifies decay rates
interface SEGEntry {
  op:     'SEG';
  anchor: string;
  target: string;           // doc_anchor
  operand: {
    boundary_type:       'paragraph' | 'section' | 'document';
    position:            number;
    decay_multiplier:    number;    // how much λ increases at this boundary
    entities_above_ws:   number;   // working-set size before boundary
    entities_retained:   number;   // working-set size after decay applied
  };
  provenance: StandardProvenance;
}

// CON: relationship between two INS'd entities
// (unchanged from current schema — reproduced for completeness)
interface CONEntry {
  op:     'CON';
  anchor: string;
  target: string;           // subject anchor
  operand: {
    object_anchor:    string;
    predicate:        string;
    relation_type:    string;
    confidence:       number;
    coref_source:     'integral_fold' | 'h1_llm' | 'user';
  };
  provenance: StandardProvenance;
}
```

### 2.4 Bifurcation and merge events

```typescript
// Bifurcation: one integral splits into two
interface BifurcationEntry {
  op:     'SEG';            // SEG is the right operator — drawing a boundary within
  anchor: string;
  target: string;
  operand: {
    kind:             'entity_bifurcation';
    original_anchor:  string;
    new_anchor_a:     string;
    new_anchor_b:     string;
    trigger:          'coherence_threshold' | 'def_conflict' | 'user';
    coherence_before: number;
    split_position:   number;   // where in the sig history the split is drawn
  };
  provenance: StandardProvenance;
}

// Merge: two integrals determined to be same entity
interface MergeEntry {
  op:     'CON';            // CON is the right operator — connecting two things
  anchor: string;
  target: string;
  operand: {
    kind:             'entity_merge';
    absorbed_anchor:  string;    // this anchor ceases to be primary
    primary_anchor:   string;    // this anchor persists
    trigger:          'integral_overlap' | 'def_equivalence' | 'user';
    compatibility:    number;    // cosine sim between accumulated embeddings
  };
  provenance: StandardProvenance;
}
```

---

## 3. Algorithm

### 3.1 Fold function: processing a SIG event

Called by the fold worker whenever a SIG entry arrives from the log worker.

```
function foldSIG(entry: SIGEntry, state: FoldState) → FoldState:

  mention_embedding = entry.operand.embedding
  position = entry.operand.position
  grain = entry.operand.grain
  surface = entry.operand.surface_form

  // 1. Apply decay to all active candidates since last event
  for each candidate c in state.candidates:
    elapsed = position - c.last_sig_position
    boundary_count = count_SEG_boundaries(c.last_sig_position, position, grain)
    decay_rate = base_decay_rate(grain) × (1 + boundary_penalty × boundary_count)
    c.integral_value *= exp(-decay_rate × elapsed)
    c.grain_values[grain] *= exp(-decay_rate × elapsed)
    if c.integral_value < DECAY_TO_ZERO and c.nul_state == 'active':
      c.nul_state = 'cleared'

  // 2. Compute working set for this grain
  working_set = [c for c in state.candidates
                 if c.grain_values[grain] >= θ_working_set
                 and c.nul_state in ('unknown', 'active')]

  // 3. Score against working set
  scores = []
  for each candidate c in working_set:
    compat = cosine_similarity(mention_embedding, c.accumulated_embedding)
    // Boost if surface form matches a prior surface form
    surface_boost = 0.15 if surface in c.surface_forms else 0.0
    // Boost if DEF frame is compatible with mention
    frame_boost = frame_compatibility(mention_embedding, c.def_frame) if c.def_frame else 0.0
    scores.append((c, compat + surface_boost + frame_boost))

  scores.sort(descending by score)

  // 4. Route the mention
  if scores is empty or scores[0].score < θ_candidate_new:
    // No compatible candidate — start new candidate integral
    new_candidate = init_candidate(mention_embedding, surface, position, grain)
    state.candidates.append(new_candidate)
    return state  // SIG log entry already written by caller with target=new_candidate.id

  elif scores[0].score >= θ_merge:
    // Clear winner — fold into best candidate
    best = scores[0].candidate
    best.integral_value += entry.operand.signal_strength
    best.grain_values[grain] += entry.operand.signal_strength
    update_welford_mean(best, mention_embedding)
    best.coherence_score = compute_coherence(best)
    best.last_sig_position = position
    best.surface_forms.add(surface)
    best.sig_count += 1

    // Check coherence — if dropping, flag for bifurcation
    if best.coherence_score < θ_coherence_warning:
      best.bifurcation_warning = True

    // Check INS threshold
    if best.integral_value >= θ_INS and best.nul_state == 'unknown':
      emit_INS(best, state.log)
      best.nul_state = 'active'

  elif scores[0].score >= θ_ambiguous:
    // Ambiguous — fold tentatively, mark for resolution
    // Same as merge path but resolution_confidence is lower
    // This produces a SIG entry with resolution_confidence < 0.65
    // which is the H1 hook trigger for LLM-assisted disambiguation

  // 5. Update working set queue for this grain
  update_grain_queue(state.working_sets[grain], state.candidates)

  return state
```

### 3.2 Fold function: processing a SEG event

```
function foldSEG(entry: SEGEntry, state: FoldState) → FoldState:

  boundary_type = entry.operand.boundary_type
  decay_multiplier = {
    'paragraph': 1.8,
    'section':   3.5,
    'document':  10.0,
  }[boundary_type]

  entities_above_ws_before = count_above_ws(state.working_sets, boundary_grain(boundary_type))

  for each candidate c in state.candidates:
    if not mentioned_in_preceding_segment(c, entry):
      c.grain_values[boundary_grain(boundary_type)] *= (1 / decay_multiplier)
      // Entity not foregrounded in this segment — faster decay

  // Recompute working sets at and below this boundary's grain level
  for grain in grains_at_or_below(boundary_type):
    update_grain_queue(state.working_sets[grain], state.candidates)

  return state
```

### 3.3 Pronoun and abbreviation resolution

The resolution routine runs when the NP extractor produces a mention that is:
- A pronoun (he, she, it, they, them, their, its)
- An abbreviation that is shorter than any current entity name
- A definite NP ("the organization", "the contractor") without a full name

```
function resolveMention(surface: string, embedding: Float32Array,
                        position: number, grain: GrainLevel,
                        working_sets: WorkingSets) → Resolution:

  queue = working_sets[grain]

  candidates = [(anchor, cosine_similarity(embedding, c.type_embedding), c.integral_value)
                for anchor, c in queue.items()]

  // Score = compatibility × recency_weight
  // recency_weight = I_e(p) / max_integral_in_queue
  max_integral = max(c.integral_value for c in queue.values())
  scored = [(a, compat × (iv / max_integral)) for a, compat, iv in candidates]
  scored.sort(descending by score)

  if not scored:
    return Resolution(status='no_candidates', nul_state='never_set')

  best_anchor, best_score = scored[0]

  if best_score >= θ_resolution_high:
    return Resolution(status='resolved', anchor=best_anchor,
                      confidence=best_score, method='integral_fold')

  elif best_score >= θ_resolution_ambiguous:
    return Resolution(status='ambiguous',
                      candidates=scored[:3],
                      confidence=best_score,
                      method='integral_fold',
                      flag_for_llm=True)    // → H1 hook if CON
  else:
    return Resolution(status='unresolved', nul_state='unknown',
                      note='no compatible entity in working set')
```

### 3.4 Cross-document resolution

Each document produces a set of instantiated entities with anchor embeddings
and integral values. Cross-document resolution uses these as seeds.

```
function crossDocCoref(doc_entities: Map<doc_anchor, EntitySet>) → MergeMap:

  // Build a corpus-level candidate set from all document entities
  // weighted by their integral values at document boundary
  corpus_candidates = []
  for doc_anchor, entities in doc_entities:
    for entity in entities:
      if entity.integral_at_doc_boundary >= θ_cross_doc:
        corpus_candidates.append(entity)

  // Cluster by accumulated embedding similarity
  // Use the same integral fold: treat cross-document co-occurrence as SIG events
  // with signal strength = min(integral_a, integral_b) / θ_INS
  merge_map = {}
  for pair (a, b) in candidate_pairs(corpus_candidates):
    compat = cosine_similarity(a.accumulated_embedding, b.accumulated_embedding)
    surface_overlap = jaccard(a.surface_forms, b.surface_forms)
    frame_compat = def_frame_compatibility(a, b) if both have DEF frames else 0.5

    combined = 0.5 × compat + 0.3 × surface_overlap + 0.2 × frame_compat
    if combined >= θ_cross_doc_merge:
      merge_map[b.anchor] = a.anchor  // b is merged into a

  return merge_map
```

---

## 4. Thresholds

All thresholds are configurable in `coref_config.json` and exposed in the
settings panel. Defaults are conservative — prefer starting new candidates
over forcing incorrect merges.

| Parameter | Symbol | Default | Meaning |
|---|---|---|---|
| `candidate_floor` | θ_candidate_new | 0.25 | Below this compat, start new candidate |
| `ambiguous_band_low` | θ_ambiguous | 0.55 | Above this, merge tentatively |
| `merge_confident` | θ_merge | 0.72 | Above this, merge with high confidence |
| `ins_threshold` | θ_INS | 4.0 | Integral value to trigger INS |
| `working_set` | θ_ws | 1.5 | Integral value to be in grain queue |
| `coherence_warning` | θ_coherence | 0.60 | Below this, flag bifurcation |
| `cross_doc_seed` | θ_cross_doc | 2.0 | Min integral to carry across documents |
| `cross_doc_merge` | θ_cross_doc_merge | 0.68 | Min combined score to merge cross-doc |
| `resolution_high` | θ_resolution_high | 0.75 | High-confidence pronoun resolution |
| `resolution_ambiguous` | θ_resolution_ambiguous | 0.50 | Ambiguous — flag for LLM |
| Base decay rates | λ_base | clause: 0.05, sentence: 0.02, paragraph: 0.008, section: 0.003 | Per-character-offset decay |
| Paragraph SEG multiplier | — | 1.8× | λ increase at paragraph boundary |
| Section SEG multiplier | — | 3.5× | λ increase at section boundary |
| Document SEG multiplier | — | 10.0× | λ increase at document boundary |

---

## 5. Integration points

### 5.1 Fold worker changes

The fold worker currently processes log entries to build M state. Extend it
with the integral state:

**New state fields on FoldState:**
- `candidates: Map<candidate_id, CandidateEntity>` — pre-INS entities
- `working_sets: WorkingSets` — per-grain queues, updated at every SEG
- `candidate_seq: number` — monotonic counter for temporary candidate IDs
- `candidate_to_anchor: Map<candidate_id, anchor>` — populated when INS fires

**Modified fold cases:**
- `case 'SIG'`: call `foldSIG`, update working sets
- `case 'SEG'`: call `foldSEG`, recompute grain queues
- `case 'INS'`: promote candidate to entity in M, remove from candidates
- `case 'CON'`: check both endpoints are in M (both INS'd); if either is still a
  candidate, the CON is premature — emit a NUL with `kind: 'premature_con'`
  and defer until both are INS'd

**New fold worker messages:**
```typescript
// Ingest pipeline → fold worker
{ type: 'GET_WORKING_SET', grain: GrainLevel }
→ { type: 'WORKING_SET', grain, entities: [{anchor, display_name, integral_value}] }

// Ingest pipeline → fold worker
{ type: 'GET_CANDIDATE_COUNT' }
→ { type: 'CANDIDATE_COUNT', count: number, above_ins_threshold: number }

// Fold worker → main thread (when bifurcation warning fires)
{ type: 'BIFURCATION_WARNING', anchor, coherence_score, sig_count }

// Fold worker → main thread (when cross-doc merge candidate detected)
{ type: 'CROSS_DOC_MERGE_CANDIDATE', anchor_a, anchor_b, combined_score }
```

### 5.2 Ingest pipeline changes

**stageNP (NP extraction):** emit SIG entries as before. Add: query fold worker
for current grain's working set before emitting. Include the working set's top
candidates in the SIG entry's `operand.resolution_candidates` (top 3 by
integral × compatibility) for downstream use.

**stageCoref (current mention-pair classifier):** replace entirely with a call
to `resolveMention` using the integral fold result. The fold worker has already
done the resolution; this stage becomes a log-entry emitter for the fold's
output.

**stageSEG (boundary detection):** emit SEG entries as before, but now also
send a `FOLD_SEG` message to the fold worker to trigger decay computation.
This is the point where the fold worker's working set queues are updated.

**stageINS (entity threshold):** replace the frequency-count threshold with
a query to the fold worker: `GET_CANDIDATE_COUNT` to check how many candidates
are above the INS threshold. The fold worker has already computed this;
the stage just needs to trigger the INS emission if it hasn't fired yet.

**stageCON (relationship detection):** before emitting any CON entry, verify
both subject and object are in M (both INS'd). If either is still a candidate,
defer the CON via a pending queue. When the missing entity crosses INS
threshold, drain the pending queue.

### 5.3 New stage: stageCROSS_DOC

Runs once after all documents in a corpus have been ingested individually.

1. Collect all INS'd entities from all document M states
2. Filter to those with `integral_at_doc_boundary >= θ_cross_doc`
3. Run `crossDocCoref` to find merge candidates
4. For each merge candidate pair:
   - Emit a CON entry with `operand.kind: 'cross_doc_merge_candidate'`
   - If combined score >= θ_cross_doc_merge: also emit an INS entry for the
     merged entity with `operand.kind: 'cross_doc_entity'` and a new anchor
   - If below threshold but above some minimum: emit a DEF entry as a frame
     comparison, let EVA/REC cycle handle the resolution

---

## 6. Reading session integration

The integral should update in real time as the user reads. This requires
the fold worker to respond to focus events from the main thread.

**Focus SIG events (from the explorer UI):**

When the user hovers or dwells on a span, the main thread sends:
```typescript
{ type: 'FOCUS_SIG', anchor_or_candidate_id, strength: 'hover' | 'click' | 'dwell' }
```

The fold worker adds a SIG event with signal strength:
- `hover`: 0.1
- `click`: 0.35
- `dwell` (embedding generated): 1.0 (full INS-strength signal)

The `dwell` event is what the existing `readOnFocus` function produces when
it generates an embedding. This is where reading the text and INS-ing an
entity is the same event — the embedding generation IS the integral crossing
threshold, if the entity wasn't already INS'd mechanically.

**Grain queue on display update:**

When the user changes grain (scroll controls depth), the main thread requests
the working set for the new grain. The inspector panel's "related entities"
section is populated from this working set, in integral-value order. This is
not a separate query — it is reading the current state of the fold's grain queue.

---

## 7. G log entries emitted by this system

Summary of all new log entry types this system introduces. All use existing
`makeEntry` with existing op codes — no schema changes.

| Op | `operand.kind` | When emitted |
|---|---|---|
| SIG | (none — existing) | Every NP mention, now with `resolution_candidates` field |
| INS | `integral_threshold_crossing` | When candidate integral ≥ θ_INS |
| SEG | `discourse_boundary` | At paragraph/section/document boundaries (existing + new fold msg) |
| SEG | `entity_bifurcation` | When coherence drops below θ_coherence and manual split confirmed |
| CON | `integral_fold_coref` | When two candidates are merged by fold (replaces mention-pair coref) |
| CON | `cross_doc_merge_candidate` | When cross-doc coref finds probable same-entity |
| CON | `cross_doc_entity` | When cross-doc merge is confirmed |
| NUL | `premature_con` | CON attempted before one endpoint is INS'd |
| NUL | `resolution_failed` | Pronoun/abbrev resolution found no compatible candidate |
| NUL | `bifurcation_warning` | Coherence drop below threshold, awaiting human judgment |
| DEF | `cross_doc_frame_comparison` | Two entities have conflicting DEF frames — below merge threshold |

---

## 8. Inspector UI additions

The entity inspector panel gains three new sections when viewing an INS'd entity.

**Integral history chart:** A small sparkline (SVG, no library needed) showing
I_e(p) over the document. X-axis is character position (or paragraph index).
Y-axis is integral value. Vertical markers at SEG events. Horizontal line at
θ_INS. The chart shows exactly when the entity crystalized, how stable its
integral has been, and whether it has decayed.

**Grain queue membership:** A row for each grain level showing whether this
entity is currently in the working set at that grain, and its current integral
value there. This makes the "focus depth" of an entity visible: an entity that
is in the document queue but not the paragraph queue is a prominent entity
that is not currently active at close reading depth.

**Coherence indicator:** Current coherence score with a color band (green above
0.75, amber 0.55–0.75, red below 0.55). If coherence is below θ_coherence_warning,
show the two sub-clusters that the bifurcation detection has identified —
clicking "split" fires the SEG bifurcation event.

---

## 9. Verification

### Unit tests (pure function, no workers)

```javascript
// T1: threshold crossing
const state = initFoldState();
// Inject 4 SIG events at signal_strength 1.0 for same candidate
for (let i = 0; i < 4; i++) state = foldSIG(sig(strength=1.0), state);
assert(state.candidates[0].integral_value >= θ_INS);
assert(state.log.last().op === 'INS');

// T2: decay at SEG boundary
const pre_integral = state.candidates[0].integral_value;
state = foldSEG(seg('paragraph'), state);
assert(state.candidates[0].integral_value < pre_integral);

// T3: three NUL states
// never-set: query for entity that has no SIG events → nul_state === 'never_set'
// unknown: SIG events exist but below INS threshold → nul_state === 'unknown'
// cleared: INS fired, then doc-level SEG, no further SIGs → nul_state === 'cleared'

// T4: disambiguation — two similar surface forms, different embeddings
const candidate_a = init_candidate(emb_a, 'NDP', ...);
const candidate_b = init_candidate(emb_b, 'NDMC PSO LLC', ...);
// Mention with emb_a resolves to candidate_a; mention with emb_b resolves to b
const res = resolveMention('NDP', emb_a, ..., working_set([a, b]));
assert(res.anchor === candidate_a.anchor);

// T5: bifurcation detection
// Fold 6 SIGs: 3 with embedding cluster A, 3 with embedding cluster B
// After INS fires, coherence should be below θ_coherence
// bifurcation_warning should be true
```

### Integration tests (fold worker + log worker)

```javascript
// T6: reading order independence of INS
// Ingest same document twice with different paragraph ordering
// Assert: same entities INS'd in both runs (may differ in INS timestamp)
// Assert: cross-doc merge correctly identifies them as same entity

// T7: grain queue correctness
// After ingesting a document, request working_set for each grain
// Assert: entities mentioned only in paragraph 1 are NOT in clause queue
// after reading to paragraph 5 (they have decayed out)
// Assert: entities mentioned in paragraph 5 ARE in clause queue

// T8: premature CON deferral
// Inject a CON entry whose object_anchor refers to a candidate (not INS'd yet)
// Assert: NUL 'premature_con' emitted immediately
// Inject SIG events to bring object candidate above INS threshold
// Assert: deferred CON is now emitted with correct anchors

// T9: cross-document merge
// Ingest 'NDP Investigation' and 'NDP Annual Report'
// Assert: 'Nashville Downtown Partnership' in both is merged to one anchor
// Assert: CON 'cross_doc_merge_candidate' emitted linking the two per-doc anchors
// Assert: conflicting $4.2M / $1.9M frames produce DEF 'cross_doc_frame_comparison'
// which then triggers the EVA pressure and REC cycle

// T10: reading session focus events
// Ingest document mechanically
// Simulate user clicking 'Nashville Downtown Partnership' twice (click SIG)
// then dwelling (dwell SIG → embedding generated)
// Assert: integral_value increases on each event
// Assert: if entity was pre-INS before, INS fires on dwell event
// Assert: INS entry has provenance.source: 'focus:read'
```

---

## 10. What replaces what

| Current implementation | Replaced by |
|---|---|
| `stageCoref` mention-pair classifier | Integral fold in fold worker; `stageCoref` becomes thin emitter |
| Frequency count in `stageINS` | Integral threshold crossing; INS fires at θ_INS not at count N |
| Static antecedent list for pronouns | Per-grain working set queues; resolution from live integral state |
| Single NUL state (SQL-style null) | Three NUL states: never-set / unknown / cleared |
| No entity decay | Decay model with SEG-boundary multipliers |
| No bifurcation detection | Coherence score + automatic bifurcation warning |
| No cross-document coref | `stageCROSS_DOC` with integral seeds from per-document M states |
| Reading session does not update coref | Focus events send FOCUS_SIG to fold worker; integral updates live |
