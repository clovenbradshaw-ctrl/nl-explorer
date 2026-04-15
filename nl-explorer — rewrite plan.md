# nl-explorer — propositional reading spec
# Sits alongside wave-fold-architecture.md and integral-coref-spec.md.
# Those specs establish entity-level integral dynamics and coreference.
# This spec extends the architecture to propositions as first-class objects.

---

## Thesis

The current system builds an entity catalog with proximity edges. That
is not reading. A document builds a propositional network — a structured
argument where each sentence contributes to, tests, extends, or
restructures what came before. The fundamental unit of tracking is wrong.
It is tracking entities when it should be tracking propositions.

**Entity-only architecture failure modes (confirmed on OstromPolyGov):**

- "NDP transferred funds to NDMC PSO LLC without competitive bidding"
  produces a co-occurrence edge plus a heuristic verb. The manner
  modifier `without competitive bidding` is either lost or treated as
  a separate NUL event. But the absence is constitutive of the
  proposition — an unbidded transfer is a different claim than a
  transfer.

- "Ostrom demonstrated that CPRs can be self-governed" produces three
  entity integrals and a co-occurrence cluster. The outer proposition's
  evidential stance (demonstrated vs. suggested vs. assumed) is not
  captured. The inner proposition has no standing of its own — it
  cannot be contested, extended, or cleared independently.

- "Carefully designed experimental studies... enabled us to test... to
  find that isolated, anonymous individuals overharvest from CPRs"
  produces: experimental studies co-occurred with individuals co-occurred
  with CPRs. The conditional structure (IF isolated AND anonymous THEN
  overharvest), the evidence quality claim (carefully designed), and the
  research operation (testing combinations) are all lost.

- 1,955-edge relationship graph is a hairball. Every sentence produces
  edges between every entity pair in it. Edges are all the same type.
  None carries propositional structure.

The fix is not better verb extraction or a larger vocabulary. The fix is
making propositions first-class anchors with their own integrals, their
own INS threshold crossings, and their own DEF frames.

---

## Part 1 — The anchor namespace

### Current state

All anchors are entity anchors: `@e:<hash>`. They are created when an
NP candidate's integral crosses θ_INS.

### Required extension

Two anchor types:

**Entity anchors** `@e:<hash>` — unchanged. Things the document treats
as stable individuated referents.

**Proposition anchors** `@p:<hash>` — claims the document makes. A
proposition is a predicate-argument structure:

```
Proposition {
  subject:    @e or @p          // agent or subject-entity
  predicate:  @ps:<slot-hash>   // predicate-slot anchor (see §3)
  object:     @e or @p or value // patient, recipient, or typed value
  modifiers:  Modifier[]        // manner, purpose, negation, temporal
  evidential: @p or null        // outer proposition whose object this is
  polarity:   ASSERTED | NEGATED | PRESUPPOSED
  stance:     Resolution face cell (see §2)
}

Modifier {
  type:     'manner' | 'purpose' | 'temporal' | 'condition' | 'negation'
  content:  string or @e
  polarity: POSITIVE | NEGATED
}
```

**Predicate-slot anchors** `@ps:<hash>` — the relational slot between a
subject-type and an object-type. Hash is derived from the pair
(subject_entity_anchor, object_entity_anchor). Multiple propositions
accumulate into the same slot; the slot develops its own DEF frame.

### Proposition INS

Propositions cross their own INS threshold via the same integral
mechanism as entities, but matching is structural, not surface.

"NDP transferred funds to NDMC PSO LLC" and "NDMC PSO LLC received the
allocation from the Partnership" accumulate to the same proposition
integral because the predicate-argument structure matches
(agent=@e:NDP, slot=@ps:NDP→NDMC, recipient=@e:NDMC) despite the
different surface form, voice, and predicate token.

Surface matching is shallow (tokenization + normalization). Structural
matching is what drives integral accumulation toward threshold. The
proposition-level integral is:

```
dI_p/dp = σ_p(p) - λ_p(p) · I_p(p)
```

where σ_p is the structural match signal (see §4) and λ_p applies
the same SEG boundary decay as entity integrals. Proposition INS fires
when I_p crosses θ_INS — the claim is now stable, established across
multiple pieces of evidence.

---

## Part 2 — The Resolution face as the CON gate

### Current state

`stageCON_cooccurrence` emits one event type for every entity pair
co-occurring in a sentence. All edges are the same type. 7,638 edges on
the Ostrom paper, 6,962 with `verb: null`.

### The Resolution face CON family

CON is not one operator. It is a six-member family indexed by Resolution
face cell (Mode × Object):

| CON type | Resolution cell | Dependencies | Fold effect |
|---|---|---|---|
| **Binding** | Relating × Entity | both endpoints INS'd | new typed edge; predicate slot accumulates |
| **Tracing** | Relating × Pattern | ≥2 supporting Binding pairs | SYN node update; not entity graph |
| **Tending** | Relating × Background | prior matching CON exists | refreshes existing edge's λ; no new log entry |
| **Clearing** | Differentiating × Background | prior proposition to negate | negation edge; marks prior superseded |
| **Dissecting** | Differentiating × Entity | both endpoints INS'd; prior conflation | distinction edge; coherence-variance event |
| **Unraveling** | Differentiating × Pattern | prior SYN node to weaken | SYN coherence drop |

**Only Binding creates new entity-graph edges.** All other types
operate on existing structure. The hairball cannot form because the
architecture has five reasons to not create an edge and one reason to
create one.

### Falsifiable prediction

If you classify every currently-CON-emitting clause's Resolution stance
on the Ostrom corpus, Binding clauses will be 10–20% of the total and
will carry essentially all the propositionally meaningful relational
structure. The remaining 80–90% are suppressible. This prediction is
testable before committing to the rebuild.

### Well-formedness constraints per CON type

Each type has its own dependency constraint. Violations are not bugs to
silently fix — they are the most interesting entries in the corpus:

- **Tending without a prior matching CON**: maintenance of a
  non-existent relationship. Same shape as EVA-without-DEF at the
  entity level. Signals that the document is invoking a relationship
  the reader is expected to supply from background knowledge.

- **Clearing without a prior proposition**: demolishing a frame that
  was never built in this corpus. Signals presupposition not established
  by these documents — the document is clearing something it assumed
  the reader already holds.

- **Tracing without supporting Binding pairs**: asserting a pattern
  with no individual instantiations in evidence. Falsifiability gap.

These DAG violations should emit to the log as a new operation type or
as EVA entries with `result: presupposition_gap`.

### Binding CON: full predicate-argument structure

A Binding CON entry carries the full proposition:

```javascript
{
  op: 'CON',
  con_type: 'binding',
  anchor: '@p:<hash>',
  target: '@e:<subject>',      // subject entity
  operand: {
    predicate_slot: '@ps:<hash>',
    object_anchor: '@e:<object>',
    predicate_token: 'transferred',
    predicate_class: null,      // filled by DEF crystallization (§3)
    object_value: 'funds',
    modifiers: [
      { type: 'negation', content: 'competitive bidding', polarity: 'NEGATED' }
    ],
    evidential: null,           // outer proposition if this is embedded
    polarity: 'ASSERTED',
    stance: 'Binding',
    site: 'Existence/Entity',
    act: 'Relating/Structure',
  },
  provenance: {
    source: 'mechanical:binding_con',
    span_start: ...,
    span_end: ...,
    confidence: ...,
  }
}
```

The negated modifier `without competitive bidding` lives inside the
proposition, not as a sibling NUL entry. The NUL entry is a projection:

```javascript
{
  op: 'NUL',
  absence_type: 'constitutive_modifier',
  proposition_anchor: '@p:<hash>',
  modifier_type: 'negation',
  content: 'competitive bidding',
  note: 'Derived from proposition modifier, not keyword match'
}
```

The proposition is the primary unit. NUL is a derived view on one of
its modifier slots, available for cross-document absence aggregation.

---

## Part 3 — Predicate vocabulary as per-slot DEF crystallization

### The mechanism

Predicate classes are not a fixed enum. They emerge from per-slot
integral accumulation:

1. The first Binding CON between a subject and object pair creates a
   predicate-slot anchor `@ps:<hash>`.

2. Each subsequent Binding event into this slot contributes its
   predicate verb's embedding to the slot's running centroid.

3. When the variance of the slot's predicate embeddings drops below
   θ_DEF (the same coherence-variance threshold used for entity DEF
   crystallization), DEF fires on the slot.

4. The slot DEF names the predicate class using the medoid verb of the
   embedding cluster.

5. The proposition INS fires at the same moment — the claim is now
   stable, typed, and named.

### Properties

- "transferred," "paid," "remitted," "allocated" → cluster into
  `financial-transfer` for the NDP→NDMC slot.

- "demonstrated," "showed," "established," "found" → cluster into
  `evidential-demonstration` for the Ostrom→CPR-can-self-govern slot.

- Same mechanism as entity DEF crystallization. No new implementation
  needed — new target.

- Bifurcation: if the slot's predicate embeddings keep diverging
  (variance stays high), two different relational types are being
  conflated under the same agent/recipient pair. This is REC pressure
  at the relational level — the same pressure that triggers entity
  bifurcation, but applied to a relationship.

### Per-document, per-corpus vocabulary

The predicate lexicon is genuinely local. The financial-transfer cluster
on NDP→NDMC may differ from the financial-transfer cluster on
Municipality→Vendor in a different document. No shared taxonomy is
imposed. Different relational slots between the same kinds of entities
crystallize different predicate classes depending on how this specific
document uses language.

---

## Part 4 — Proposition structural matching

### Problem

Proposition INS requires that structurally equivalent propositions
accumulate to the same integral even when surface form differs.

"NDP transferred funds" and "the Partnership remitted the allocation"
need to match if they are the same propositional claim.

### Matching strategy

Three-tier match, cheapest first:

**Tier 1: Slot match** — does this clause's subject and object resolve
to the same entity anchors as a prior Binding CON? If yes, accumulate
to that proposition's integral at full weight.

**Tier 2: Predicate-class match** — does this clause's predicate verb
embed near the slot's existing predicate centroid (once it has one)?
If yes, accumulate at 0.8 weight. If no, create a bifurcation pressure
event.

**Tier 3: Structural-paraphrase match** — does the clause's full
embedding sit near an existing proposition anchor's structural
embedding? This is the LLM hook (H1) — invoked only when Tier 1 and
Tier 2 are inconclusive. Output: `same_proposition: bool`.

### The embedded proposition problem

"Ostrom demonstrated that CPRs can be self-governed" has two
propositions:

```
P1: Ostrom → demonstrated → [P2]
P2: CPRs → can-self-govern → (no specific object)
```

P2 is the object of P1. P2 has its own anchor, its own integral, its
own DEF frame. P1 is an evidential wrapper that sets P2's epistemic
standing from "hypothesis" to "finding."

When P2's integral crosses INS independently (from other Binding CONs
that make the same claim), P2 is established regardless of P1. When P1
accumulates (from other documents that also say Ostrom demonstrated
this), P1 is established as a stable evidential relationship.

The evidential modifier on P2 is:

```javascript
{
  type: 'evidential',
  source_proposition: '@p:P1',
  agent: '@e:Ostrom',
  predicate_class: 'evidential-demonstration',
  elevates_standing_to: 'finding'
}
```

The system tracks who demonstrated what, with what predicate. Not just
that two entities co-occurred near "demonstrated."

---

## Part 5 — The integral equation for propositions

### Entity integral (existing)

```
dI_e/dp = σ_e(p) - λ_e(p) · I_e(p)
```

where σ_e is Site-face-weighted signal (Entity site > Background site >
Pattern site — see wave-fold-architecture.md §Resolution face) and λ_e
is SEG-boundary-modulated decay.

### Resolution-face modulation on σ (entity level, extended)

From the wave-fold spec, but now integrated with proposition awareness:

| Resolution stance | σ modifier | λ modifier | target |
|---|---|---|---|
| Making / Composing | × 1.8 | × 1.0 | entity integral |
| Binding / Tracing | × 1.0 | × 1.0 | entity integral + slot |
| Tending | × 0.0 | × (1 - τ) | λ decay suppression only |
| Clearing / Dissecting | × -0.6 | × 1.0 | see §2 decrement targets |
| Cultivating | × 0.3 | × 1.0 | unknown-NUL precursor slot |

**Tending modifies λ, not σ.** This is the critical distinction.
Repeated Tending events cannot push an integral past θ_INS. Ten
"as we have seen..." references to an entity keep it warm without
building it up. Repeated small σ spikes from weak-but-positive signals
do accumulate. These are different behaviors and must be separate in
the equation.

### Proposition integral

```
dI_p/dp = σ_p(p) · match_weight(p) - λ_p(p) · I_p(p)
```

where:

- `σ_p(p)` is the clause's Binding signal strength (Site × Act face
  product, see §2)
- `match_weight` is the tier from §4 (1.0 for slot match, 0.8 for
  predicate-class match, 0.5 for paraphrase match, 0.3 for structural
  near-miss)
- `λ_p` is the same SEG boundary decay

Proposition INS fires at the same θ_INS. The proposition is established
as stable when the accumulated structural evidence crosses threshold.

---

## Part 6 — DEF at the proposition level

Entity DEF frames: what the entity is — its neighbor set in the CON
graph, its predicate types, its structural position.

Proposition DEF frames: what the claim asserts — its predicate class,
its argument types, its modifier structure, its evidential standing,
and the accumulated evidence that establishes it.

A proposition's DEF frame crystallizes when:

1. Its predicate slot has a crystallized predicate class (§3)
2. Its argument entities both have INS'd anchors
3. Its modifier pattern has stabilized (modifier-variance below θ_DEF)

Until all three conditions hold, the proposition is in a partial-DEF
state — the same "face committed, axis uncertain" logic as the
cube/face decomposition for EVA entries.

### Partial proposition DEF

A proposition can have:
- Agent known, predicate class crystallized, object uncertain → partial
  DEF, unknown on Object axis
- Agent known, object known, predicate class not yet crystallized →
  partial DEF, unknown on predicate axis
- Full DEF → all three slots crystallized

These partial states emit to the log as DEF entries with
`resolution: 'partial'` and `unknown_axis: 'object' | 'predicate'`.

---

## Part 7 — EVA at the proposition level

### Current state

EVA classifies clauses against 27 centroids. The outcome (satisfies /
extends / contracts / conflicts) is derived from confidence gap and
z-score thresholds. These are proxies for an epistemic distinction the
Resolution face measures directly.

### Proposition-level EVA

EVA tests a new proposition against the established DEF frame of a
prior proposition:

| EVA outcome | Resolution stance of new clause | Effect |
|---|---|---|
| satisfies | Tending or Binding consistent with frame | Frame confidence increases |
| extends | Tracing or Composing adding to frame | Frame grows; no conflict |
| contracts | Clearing or Dissecting removing from frame | Frame shrinks; pressure may build |
| conflicts | Making or Binding incompatible with frame | Conflict event; REC pressure |

This is the measurement replacing the proxy. The EVA outcomes are
Resolution face cells, not confidence thresholds.

### Cross-document investigative EVA

Document A: "NDP transferred $4.2M to NDMC PSO LLC in FY2019."
Document B: "NDP transferred $1.9M to NDMC PSO LLC in FY2020-2021."

Both entity integrals (NDP, NDMC) are stable. The conflict is not
visible at entity level. It is a proposition-level EVA event:

- Same predicate slot: `@ps:NDP→NDMC:financial-transfer`
- Same predicate class: crystallized from prior Binding events
- Different numeric arguments: $4.2M vs $1.9M
- Same temporal scope or overlapping temporal scope
- EVA result: `conflicts` — same slot, same class, incompatible value

The REC candidate is not about any entity. It is about the proposition:
same transfer with different reported amounts? Two different transfers?
Misreporting? Fraud? The question lives at the relational level.

This is what makes the system fit for investigative reading. The entity
graph cannot formulate this question. Proposition-level EVA can.

---

## Part 8 — NUL from proposition structure

### Current state

8 NUL entries for the Ostrom paper, all `explicit_claim` keyword
matches. Expected ratio of structural-to-explicit: ~5:1 or higher.

### Three NUL states as Resolution face derivatives

**Never-set:** No Cultivating events have ever targeted this slot.
The document has never gestured toward it.

**Unknown:** Cultivating events exist for this slot without follow-up
Making. The document is repeatedly gesturing toward something it
never instantiates. This is different from "an NP appeared but didn't
reach threshold" — it is the document performing a gesture as a mode.
Cultivating-without-Making is its own epistemic state.

```
If Count(Cultivating → @slot) > 0 AND Count(Making → @slot) == 0
  → emit NUL(unknown, slot)
```

**Cleared:** Making events exist for this slot, followed by either
sustained absence of Tending (decay) or explicit Clearing/Dissecting.

```
If I_slot > θ_INS was true at time t
  AND I_slot < θ_floor is true at time t'
  → emit NUL(cleared, slot, decayed_since: t)
```

### Constitutive modifiers as NUL projections

The modifier `without competitive bidding` inside a Binding CON emits
a NUL projection:

```javascript
{
  op: 'NUL',
  absence_type: 'constitutive_modifier',
  nul_state: 'asserted_absent',
  proposition_anchor: '@p:<hash>',
  slot: 'competitive-bidding-process',
  note: 'Absence is constitutive of the proposition, not a separate finding'
}
```

The NUL lives inside the proposition's modifier structure AND emits to
the NUL index for cross-document aggregation. Both representations are
needed. The proposition is primary; the NUL entry is a derived view.

---

## Part 9 — Budget gate: where to spend extraction

### The extraction cost problem

Proposition extraction requires predicate-argument identification with
modifier attachment. This is expensive. The system cannot afford to
extract from every clause.

### Resolution face as budget gate

The Resolution face classifies clause stance cheaply (centroid lookup).
Extraction budget is allocated by stance:

| Resolution stance | Extraction | Rationale |
|---|---|---|
| Binding | Full SPO + modifier extraction (LLM or parser) | Only Binding creates propositions |
| Tracing | Extract predicate class + entity types, no individual arguments | Pattern-level, not instance-level |
| Tending | No extraction | Just refresh existing CON integral |
| Background clauses (any) | Weak diffuse frame update | Atmospheric; no propositions |
| Clearing / Dissecting | Extract enough to identify what is being negated/distinguished | Connect to prior proposition |
| Unraveling | Extract pattern features to identify which SYN node is weakening | |
| Cultivating | Extract slot target for unknown-NUL tracking | |

**~80% of clauses get cheap stance-and-integral updates. Only the
Binding ~10-20% get expensive extraction.** The architecture is honest
about its limits. The Resolution face tells the system where to spend
budget before spending it.

---

## Part 10 — EVA multi-tier measurement

From the Claude Code session's `classifyClause` extension:

```javascript
{
  cube: { cell_id, gap, profile_27 },
  faces: {
    act:        { cell_id, gap, profile_9 },   // Mode × Domain
    site:       { cell_id, gap, profile_9 },   // Domain × Object
    resolution: { cell_id, gap, profile_9 },   // Mode × Object  ← primary EVA carrier
  },
  axes: {
    mode:   { value, gap, profile_3 },
    domain: { value, gap, profile_3 },
    object: { value, gap, profile_3 },
  },
  consistency: {
    faces_imply_cube: bool,
    dominant_face: 'resolution' | 'act' | 'site' | null,
    disputed_axis: 'mode' | 'domain' | 'object' | null,
  }
}
```

**The Resolution face is the primary EVA outcome carrier.**

The cube cell becomes a derived field — present when all three faces
co-locate to a single cube cell, marked provisional when they don't.

`consistency.disputed_axis` is what H3 currently recovers by asking
the LLM to label three letters. With face centroids, it derives from
arithmetic on the similarity profiles. LLM escalation only when faces
disagree with each other — far cheaper, fully auditable.

### EVA boundary diagnosis (replacing the flat-profile flag)

Old: `confidence_gap < 0.08` → boundary flag → 92% of clauses.

New: three structurally distinct situations:

1. **Cube flat, two faces decisive:** one axis is uncertain. The
   disputed axis is identifiable. The clause can commit to a face
   cell rather than a cube cell. This is not noise — it is a real
   partial commitment.

2. **Cube flat, Site decisive, Resolution split:** the document is
   doing a recognizable transformation on an under-defined object.
   Partial proposition commitment.

3. **All faces flat:** genuinely off-distribution. Real REC pressure.
   The clause hasn't earned a frame yet.

### Reading-grain alignment

Early in a document, integrals haven't crystallized; cube classifications
produce flat profiles by construction. The face decomposition provides a
graceful fallback ladder:

```
cube decisive            → commit to cube cell
cube flat, faces decisive → commit to face cell, third axis open
faces split              → commit to dominant face, others open
all faces flat           → SIG only, no EVA — clause hasn't earned a frame
```

This makes EVA grain-sensitive. The integration window matches the
entity's DEF frame maturity. Cube is sentence-grain. Face is
paragraph-grain. Axis is section-grain.

---

## Part 11 — M state additions

The fold worker's M state currently holds:

```
M.entities     Map<anchor, entity>
M.defFrames    Map<anchor, frame>
M.conEdges     Map<key, edge>
M.evaHistory   Map<anchor, EVA_entry[]>
M.recPending   Map<anchor, REC_candidate>
M.pressure     Map<anchor, pressure_score>
M.displayNames Map<anchor, string>
```

New additions:

```
M.propositions     Map<@p:hash, proposition>
M.predicateSlots   Map<@ps:hash, slot>
M.propIntegrals    Map<@p:hash, integral_value>
M.slotIntegrals    Map<@ps:hash, integral_value>
M.propDEFFrames    Map<@p:hash, prop_frame>
M.cultivating      Map<slot, Cultivating_event[]>  // unknown-NUL precursors
M.negated          Map<@p:hash, @p:hash>           // negation edges
M.distinctions     Map<@e:hash, Set<@e:hash>>      // Dissecting results
```

The OPFS checkpoint schema grows to include these. The fold worker
`get_graph` op returns nodes as `{entities, propositions}` and edges as
`{binding, tracing, clearing, dissecting, tending_refreshed}`.

---

## Part 12 — Log entry additions

### New `op` values

None. All new log entries use existing operators with new operand
structure:

- **INS** with `target: 'proposition-registry'` and
  `operand.anchor_type: 'proposition'`
- **CON** with `operand.con_type: binding|tracing|tending|clearing|dissecting|unraveling`
- **DEF** with `operand.param: 'predicate_class'` for slot DEF
  crystallization
- **EVA** with `operand.eva_type: 'proposition_frame_test'` for
  proposition-level frame testing
- **NUL** with `operand.absence_type: 'cultivating_without_making' |
  'constitutive_modifier' | 'proposition_decayed'`
- **REC** with `operand.trigger: 'proposition_conflict'` for
  relational-level frame bifurcation

The helix ordering is preserved. Operator semantics are unchanged.
The new content lives in the operand structure, not in new operators.

---

## Part 13 — Sequence changes in `ingest()`

Current sequence (from pipeline-rewrite-plan.md):

```
SIG_NPs + pronouns + reframe
  → flush → get_entity_anchors
  → stageINS_definitions → stageCON_cooccurrence → stageSPO → stageSYN
  → flush → crystallize_frames
  → flush → get_all_frames + get_integrals → stageEmbeddingClassify
  → stageEVA_temporal → stageNUL
```

New sequence:

```
SIG_NPs + pronouns + reframe
  → flush → get_entity_anchors

  → stageINS_definitions

  → stageEmbeddingClassify_stance   // classify Resolution face only,
                                    // don't emit EVA yet — just label
                                    // each clause with its stance

  → stageCON_typed                  // replaces stageCON_cooccurrence
    → Binding clauses only → full SPO extraction
    → Tracing → pattern features
    → Tending → refresh existing
    → Clearing/Dissecting/Unraveling → negation/distinction/weakening
    → Cultivating → unknown-NUL precursor

  → stageSPO_from_binding           // SPO now derives from Binding CON,
                                    // not separately extracted

  → stageSYN                        // from Tracing CON, not Binding

  → flush → crystallize_frames      // entity DEF
          → crystallize_slots       // predicate-slot DEF

  → flush → get_all_frames
          → get_all_slots
          → get_integrals
          → stageEVA_proposition    // EVA against proposition frames
          → stageEVA_temporal

  → stageNUL_structural             // from Cultivating-without-Making
                                    // and Clearing events
  → stageNUL                        // keyword fallback (kept but demoted)
```

The key change: Resolution face classification happens first, before
any CON emission. The stance gates what extraction work follows.

---

## Verification

On OstromPolyGov and NDP investigation corpus:

**Proposition network structure:**
1. Binding CON count is 10–20% of current total CON count. Graph is
   legible — Binding edges with typed predicates, a few Tracing edges,
   a few Clearing edges demolishing prior assumptions.
2. Predicate slots crystallize with recognizable class names for the
   dominant relational structures (financial-transfer, authorization,
   governance-finding, evidential-demonstration).
3. "Without competitive bidding" appears as a constitutive modifier
   on the Binding CON proposition, not as a separate NUL keyword match.

**Proposition INS quality:**
4. "NDP transferred funds to NDMC PSO LLC" and variants accumulate to
   the same proposition integral — verified by checking that subsequent
   surface-varied occurrences increment the same `@p` anchor.
5. "Ostrom demonstrated that CPRs can be self-governed" produces two
   proposition anchors — the outer evidential and the inner claim —
   with the inner claim independently trackable across documents.

**EVA diagnosis:**
6. EVA flat-profile rate drops from 92% when using Resolution face
   as primary carrier vs. Act face centroid.
7. Boundary cases are classified into the three diagnostic types
   (axis-uncertain, face-split, genuinely-off-distribution) rather than
   collapsing to a single `boundary` flag.
8. `consistency.disputed_axis` agrees with H3 tiebreak outputs on the
   test set — verifying that arithmetic on face profiles recovers what
   the LLM was being asked to recover.

**Cross-document investigative EVA:**
9. The $4.2M vs $1.9M figure conflict on the NDP→NDMC financial-transfer
   slot fires a proposition-level EVA `conflicts` entry. No entity is
   individually under pressure. The conflict is at the relational level.
10. The audit trail for this conflict traces to the specific Binding CON
    entries from each document with their spans and confidences.

**NUL coverage:**
11. Structural NUL entries (Cultivating-without-Making, Clearing,
    constitutive-modifier projections) outnumber keyword NUL entries by
    at least 3:1.
12. Three-state NUL classification (never-set / unknown / cleared) is
    derivable from log history without keyword detection — verified by
    disabling the keyword NUL stage and checking that the structural
    stage recovers the same 8 original entries plus additional ones.

**Site-face routing:**
13. NPs filtered by `isDisplayableEntity` cluster on Background-site
    clause classification at rate > 0.7. This verifies that
    `isDisplayableEntity` was an unprincipled approximation of Site-face
    routing. Test enables the replacement to be data-justified.
