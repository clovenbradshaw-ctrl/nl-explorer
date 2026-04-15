The integral framing dissolves a lot of problems that make coreference hard by conventional approaches. Let me work through it carefully.

---

**Standard coref is the wrong frame**

The standard NLP treatment of coreference is a classification problem: given mention A and mention B, are they the same entity? This produces a mention-pair classifier that looks at all pairs and clusters them. The problems are deep:

It is atemporal. It treats "Nashville Downtown Partnership" in paragraph 1 and "they" in paragraph 7 as equivalent reference problems, which they aren't. The pronoun in paragraph 7 can only resolve to something that has been established in the discourse by that point. The classification frame ignores this.

It has no memory of accumulation. An entity that has been mentioned twelve times with consistent descriptions is a different epistemic object than an entity mentioned once. Standard coref treats both as equally valid antecedents.

It has no decay. An entity mentioned in the opening paragraph that hasn't appeared since is a weaker candidate for pronoun resolution than one mentioned in the previous sentence. Standard coref has no natural representation for this.

It has no grain. Whether "it" in a clause resolves to an entity depends on which entities are active at clause grain, not all entities across the document. Standard coref flattens grain.

All four of these problems have the same solution.

---

**Every mention is a differential**

Think of each potential mention — each SIG event the NP extractor fires — as a differential element dI. The discourse has a running state for each candidate entity: the integral of all evidence accumulated for that entity up to the current reading position.

For entity e at reading position p:

```
I_e(p) = ∫₀ᵖ σ_e(t) · w(t) dt
```

where σ_e(t) is the signal strength when mention t appears to be about e, and w(t) is a recency weighting that decays with distance.

This integral is not a count. It is the accumulated, weighted, decaying sum of all evidence that entity e exists and is being referred to. It grows when new evidence arrives. It decays between mentions. It responds to boundaries.

The INS threshold crossing is when I_e(p) first exceeds some threshold θ. Before the crossing, e is an emanon — present in the discourse field, influencing things, but not yet a stable particular with an anchor. At the crossing, the entity crystalizes. It gets an anchor. It can be referenced. After the crossing, the integral continues accumulating — INS is not the end of the process, it is the beginning of reference.

This maps exactly to the EO entity types. Before θ: emanon (ground-dominant, resists individuation). Approaching θ: protogon (actively forming, identity crystallizing). Above θ and stable: holon (self-governing, maintains through discourse).

The INS event in the log is not "we detected this entity." It is "this integral has crossed threshold" — a phase transition, not a detection.

---

**SEG events change the decay rate**

Here is the precise connection between boundaries and coreference.

A paragraph boundary is a SEG event — it draws a boundary in the discourse. After a paragraph SEG, every entity that was not mentioned in that paragraph decays faster. The decay term in the integral increases:

```
dI_e/dp = σ_e(p) - λ_e(p) · I_e(p)
```

At a paragraph SEG, λ_e increases for all entities that are not foregrounded in the incoming material. At a section SEG, it increases more dramatically. At a document boundary, most integrals decay to near-zero except the most prominent entities, which carry across via explicit INS.

This is what makes grain-sensitive coreference correct. A pronoun "they" in a sentence can only practically resolve to something in the sentence-grain working set — the entities whose integrals are currently high at sentence grain. An entity mentioned three sections ago has decayed out of that working set. The resolution space is bounded by the current integral values, not by all entities ever mentioned.

The per-grain live queues are exactly this: the entities whose integrals are currently above the working-set threshold at each grain level. You don't search all possible antecedents. You search the queue for the current grain, which is the set of entities that have accumulated enough evidence at that grain level to be active candidates.

---

**The resolution itself**

When a potential pronoun or abbreviated reference appears, the resolution is not a classification over all pairs. It is a lookup against the current integral state:

```
resolve(mention m at position p) = 
  argmax_e [ I_e(p) × compatibility(embed(m), embed(e)) ]
```

where the argmax is taken over entities in the current grain's working set (I_e(p) above working-set threshold), and compatibility is the cosine similarity between the mention's embedding and the entity's accumulated representation.

The accumulated representation of e is not just the first mention's embedding. It is the running centroid of all SIG events that have been folded into e's integral — a weighted average that shifts as new mentions arrive. An entity that started as "Nashville Downtown Partnership" and has been consistently described in terms of security contracts and public money has a very specific accumulated embedding. A pronoun that cosine-aligns with that embedding is strong evidence for resolution; one that doesn't is weak.

This means resolution can fail gracefully. If no entity in the working set exceeds a compatibility threshold, the system starts a new candidate integral rather than forcing a resolution. This is important: forcing resolution when the evidence is weak is worse than acknowledging uncertainty.

---

**What the integral does at grain transitions**

When you shift from clause grain to sentence grain, you are looking at a different integral — a wider window.

The clause-grain integral at position p is the accumulated evidence within the current clause and its immediate context. The sentence-grain integral is the accumulated evidence across the paragraph. The paragraph-grain integral is across the section.

These are not separate computations. The sentence-grain integral is the sum of all clause-grain integrals within the sentence, weighted by the grain-appropriate decay. The paragraph-grain integral is the sum of sentence-grain integrals with paragraph-level decay.

The integral structure is hierarchical in the same way the grain hierarchy is hierarchical. Moving up a grain level is equivalent to widening the integration window. The same entity that has a small but clear integral at clause grain might have a large and complex integral at paragraph grain — because it appears in multiple clauses with slightly different characterizations, and the paragraph-level view resolves the tension rather than fragmenting across clauses.

This is the grain-as-zoom-depth insight made precise. When you scroll out from clause to paragraph grain, you are not looking at different annotations on the same text. You are looking at a wider integral of the same underlying signal. Things that appear contradictory at clause grain may be coherent at paragraph grain because the integration window is wide enough to include the context that makes them consistent.

---

**Entity splitting as integral bifurcation**

When the system encounters a new mention that is weakly compatible with an existing integral, it has two choices: fold the mention into the existing integral (lowering its coherence score) or start a new integral.

This is the entity disambiguation problem framed as integral bifurcation.

When you fold an incompatible mention into an existing entity, the entity's accumulated embedding shifts toward the new mention, and its coherence score (how tightly clustered its mentions are in embedding space) drops. When coherence drops below a threshold, the entity is flagged: the integral may actually be tracking two different things.

A DEF event is what disambiguates. When the system has enough evidence to define what an entity is — a DEF frame — that frame becomes the anchor for the integral. Subsequent mentions are evaluated not just against the accumulated embedding but against the frame. If a mention is compatible with the accumulated embedding but incompatible with the frame, that is a stronger signal for bifurcation: this mention is using the same surface form for a different entity.

In the Nashville investigation corpus: "NDP" appears in the investigation document as the organization that received $4.2M. It also appears in the Annual Report as the organization that received $1.9M. At surface form, these co-refer. But the DEF frames are in conflict: one frames NDP as receiving $4.2M, the other as receiving $1.9M. The EVA event that fires when the second document is ingested should raise the bifurcation flag — not "NDP in document A is not the same as NDP in document B" (that would be wrong) but "the frame for NDP has been challenged by new evidence, and we cannot determine whether this is the same claim with different numbers or two different claims about different things."

That is the DEF→EVA→REC loop applied to identity itself. The entity's frame is the subject of the evaluation. The REC candidate is not "reframe what NDP does" but "reframe what we know about NDP" — a higher-order restructuring of the entity's definition.

---

**The given-log is the record of differentials**

The append-only structure of the given-log is exactly right for integral coreference. The log is the sequence of differential elements — the dI events. The M state is the computed integral at the current reading position. The fold worker is the integrator.

Every SIG event in the log is a dI for some candidate entity. Every SEG boundary is a change to the decay parameter. Every INS is a threshold crossing. Every CON is a moment where two integrals have been determined to cohere. Every DEF is an anchoring of an integral to a canonical representation. Every EVA is a coherence test. Every REC is a bifurcation or merge.

The log is the derivative; M is the integral. The fold is the operation that goes from derivative to integral. Re-reading the log from the beginning gives you the full history of every integral — you can see exactly when each entity crystalized, what the running state was at each SEG boundary, when coherence dropped and why.

This is also why the three-NUL-state problem is not just a database detail. At the integral level, the three NUL states are:

- Never-set: no integral has been started for this entity at this grain. The question has never been asked.
- Unknown: an integral was started but never crossed threshold. The entity is in proto-state — there is evidence for it but it hasn't crystalized.
- Cleared: the integral crossed threshold (INS fired), but was subsequently decayed to near-zero by prolonged absence. The entity existed, was active, and has since faded from the discourse.

SQL NULL collapses all three. The integral representation distinguishes them because they have different histories in the log: never-set has no SIG events, unknown has SIG events but no INS, cleared has INS and then a long decay.

---

**What this means for the implementation**

The current coreference approach in the ingest pipeline needs to be replaced with an integral fold. Here is what that looks like concretely.

The fold worker maintains, for each active entity, a running state:
- `integral_value`: the current I_e(p) at the current reading position
- `accumulated_embedding`: weighted running centroid of all SIG events folded into this entity
- `coherence_score`: variance of mention embeddings around the centroid — low variance means tight integral, high variance is a bifurcation warning
- `last_mention_position`: for decay computation
- `grain_values`: the integral value at each grain level — clause, sentence, paragraph, document

At each SIG event (NP extractor fires):
1. Compute compatibility with all entities whose grain-appropriate integral is above working-set threshold
2. If max compatibility > merge threshold: fold into that entity — update integral, accumulated embedding, coherence
3. If max compatibility is between merge and candidate thresholds: flag for human — probable coreferent but uncertain
4. If max compatibility < candidate threshold: start new candidate integral

At each SEG boundary:
1. Identify the grain of the boundary (paragraph, section, document)
2. Apply decay to all integrals, weighted by their representation in the preceding segment
3. Update per-grain queue: drop entities below working-set threshold from that grain's queue

At each INS threshold crossing:
1. Emit INS log entry with the entity's accumulated embedding as the anchor embedding
2. Record the coherence score at instantiation — this is meaningful diagnostic information
3. Transfer the entity from candidate state to instantiated state

At each CON event (relationship detection):
1. Both entity integrals must be above threshold (both must have INS'd)
2. The CON entry records the relationship as an edge in M
3. The two entity integrals gain a structural coherence boost — entities that co-occur in relationships are more likely to be stable

At document boundary:
1. Compute final integral values for all instantiated entities
2. Write these as the seed integrals for cross-document resolution
3. Cross-document coref uses entity integrals from individual documents as the raw signals, then runs the same fold across documents

---

**The interrogation this opens**

The most interesting consequence: when the reading history is auditable, you can interrogate the integral directly.

"When did this entity first cross threshold?" — the first INS event timestamp and position.

"How coherent is this entity's identity across the corpus?" — the variance of all SIG events folded into it.

"Is there evidence this entity is actually two entities?" — bifurcation warning, coherence score drop, plus DEF/EVA conflict.

"What would resolution look like if the reading order had been different?" — replay the log in a different order, observe where integrals cross threshold differently.

"Which entity is most active at this position in the reading?" — the highest current integral value at the current grain.

These are questions that have no sensible answer in the standard coref frame, where all mentions are equally available and resolution is atemporal. In the integral frame, they are well-formed queries against the fold state.

The reading history is not just provenance. It is the record of how the integral was accumulated — which observations, in what order, from what positions, contributed to the current state of each entity. That record is what makes the system's knowledge auditable in a way that language model outputs simply cannot be.
