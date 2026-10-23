# Data Model Contract

The canonical model is general-purpose. `canon` is a story-specific authority concept; it is not a universal synonym for truth.

## Core records

| Record | Meaning | Authority and ownership |
|---|---|---|
| Workspace | Independent data, settings, and access boundary | User-owned |
| Source / SourceVersion | Original file or text and immutable content version | Source manager |
| Evidence | Recoverable source excerpt or explicit user record | Source-linked, revisioned |
| Entity / Alias | Stable identity and alternate names | Knowledge core |
| Claim | Subject-predicate-object assertion | Keeps evidence, epistemic state, and review state separate |
| Relation | Typed, directed link between entities | Branch-scoped; reviewable |
| Event / State | Occurrence and computed state at a domain time | Time and evidence required as available |
| JournalEventVersion | A user's account of an episode, with optional source, participants, and exact, ranged, relative, or unknown timing | Branch-scoped, provenance-preserving, append-only corrections; not independently verified truth |
| Belief / Knowledge | What an actor knows, believes, denies, or lacks | Actor- and awareness-order-scoped |
| Rule | Constraint on a subject, predicate, and value | Branch-scoped, reviewed, hard or soft; evaluator reports satisfied, violated, or unknown |
| Revision / Branch | Versioned change and isolated alternate path | Append-only history; explicit promotion |
| Conversation / Turn | LKE story exchange and ordering | Branch-scoped; local generation provenance |
| ExternalExchange | Untrusted imported transcript segment, context manifest, turn range, and proposal references | Immutable, branch-scoped archive; deduplicated and continuity-checked by transcript ID |
| Scenario | Options, constraints, assumptions, and conditional outcomes | Separate from baseline truth |
| StyleProfile | Descriptive or user-preferred narrative traits | Provenance and confidence required |
| Job / Approval | Processing, permission, review, and result | Auditable; scoped authority |

Review status (`proposed`, `accepted`, `rejected`) is distinct from epistemic status (`unknown`, `believed`, `known`, `contested`). A proposal can be accepted for recording while the proposition remains uncertain. Conflicting accounts remain independently addressable with provenance.

## Time

Records may carry valid time, recorded time, actor awareness time, narrative order, and branch revision. Time values may be exact, relative, interval-valued, or unknown. A correction changes the account from its recorded point; a retcon revises world truth and must create a new revision while preserving the prior state.

## Branches and identity

Stable entity IDs are scoped to a workspace and branch snapshot. Creating a branch snapshots records from an exact parent revision. Subsequent writes remain branch-local. A source archive is shared within a workspace; its evidence links and accepted knowledge are branch-aware. Promotion is an explicit, human-reviewed fast-forward into the direct parent, allowed only while the parent remains at the exact source revision and the child head matches the reviewed head. One parent revision records the promotion; child history remains intact and identifies the provenance for the promoted state. A stale parent or stale reviewed head is rejected without a merge. Automatic conflicting merges are out of scope for v0.1.

## SQLite v7 implementation

The current schema provides `workspaces`, `branches`, `revisions`, `commands`, `entities`, `relations`, `claims`, `rules`, `actor_beliefs`, `sources`, `evidence`, `entity_evidence`, `story_conversations`, `story_turns`, `external_exchanges`, `journal_events`, `scenarios`, `scenario_options`, `scenario_claim_evidence`, `scenario_source_evidence`, `scenario_assumptions`, `extraction_batches`, `extraction_candidates`, `audit_events`, and `projection_outbox`, plus FTS5 entity and source indexes. Story turns carry provider/model provenance, narrative order, the exact context manifest JSON and ID, and the revision used for generation. External exchanges preserve untrusted transcript segments, their declared context manifest, turn ranges, stable transcript ID, and content hash; segment gaps and conflicting overlaps are reported by transcript ID. Branch snapshots copy conversations, turns, external exchanges, rules, all journal-event versions, scenarios, evidence links, options, every assumption version, and extraction provenance/candidate review state before allowing branch-local continuation. Journal entries preserve source quotes, participant labels, and exact, ranged, relative, or unknown timing. A correction appends a version; earlier wording and conflicting accounts remain retrievable. Claims and awareness records use relative narrative order to prevent future-knowledge leakage.

Extraction batches record the immutable source digest, local model, extractor/prompt versions, and output schema version. Entity and claim candidate payloads are immutable and retain an exact source quote plus character offsets. Candidate review status and any created canonical record are stored separately. AI-originated batches cannot review themselves; a user acceptance command creates the entity/claim and its evidence atomically. These records are branch-scoped while their original source remains workspace-scoped.

The rule evaluator supports one reviewed require/forbid condition per rule. It uses accepted public claims marked known, respects an explicitly declared single-valued predicate, and keeps missing, private, unreviewed, uncertain, or conflicting evidence unknown. Each scenario records its problem, constraints, two or three options, and links to branch claims and workspace sources. Assumptions are stored separately from claims as append-only versions; proposals are excluded until accepted. A `replace` assumption overlays a single-valued property for one option, while `add` overlays a value on a multi-valued property. Each option receives deterministic rule outcomes marked as baseline or conditional, with claim and assumption references kept distinct. These checks do not score outcomes or generate model recommendations. Scenario records and assumptions are immutable and branch-scoped. Journal event accounts are manually recorded and remain personal accounts even when linked to a source. They are not yet extracted into general domain events, linked to canonical entity identities, or used for temporal question answering. Aliases, computed states, scene state deltas, approvals, and generalized valid-time intervals remain target-model items.

`promote_branch` carries a reviewed child snapshot into its unchanged direct parent. Existing mutable entity, relation, claim, rule, conversation, and extraction-review state is applied to matching records; branch-local records are inserted in foreign-key dependency order. Append-only journal events, scenarios, options, evidence links, assumptions, extraction batches, and candidate payloads are preserved without updating or deleting parent history. New or updated branch revision markers point to the parent's single promotion revision, while the source branch and its full command history remain available as provenance. Entity search is rebuilt from the promoted parent state. Promotion does not convert scenario assumptions into claims, and it does not merge concurrent parent edits.
