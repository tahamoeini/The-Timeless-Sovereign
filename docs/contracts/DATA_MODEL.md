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
| Conversation / Turn | Actual exchange and ordering | Imported with deduplication metadata |
| Scenario | Options, constraints, assumptions, and conditional outcomes | Separate from baseline truth |
| StyleProfile | Descriptive or user-preferred narrative traits | Provenance and confidence required |
| Job / Approval | Processing, permission, review, and result | Auditable; scoped authority |

Review status (`proposed`, `accepted`, `rejected`) is distinct from epistemic status (`unknown`, `believed`, `known`, `contested`). A proposal can be accepted for recording while the proposition remains uncertain. Conflicting accounts remain independently addressable with provenance.

## Time

Records may carry valid time, recorded time, actor awareness time, narrative order, and branch revision. Time values may be exact, relative, interval-valued, or unknown. A correction changes the account from its recorded point; a retcon revises world truth and must create a new revision while preserving the prior state.

## Branches and identity

Stable entity IDs are scoped to a workspace and branch snapshot. Creating a branch snapshots records from an exact parent revision. Subsequent writes remain branch-local. A source archive is shared within a workspace; its evidence links and accepted knowledge are branch-aware. Promotion requires an explicit reviewed operation. Automatic conflicting merges are out of scope for v0.1.

## SQLite v4 implementation

The current schema provides `workspaces`, `branches`, `revisions`, `commands`, `entities`, `relations`, `claims`, `rules`, `actor_beliefs`, `sources`, `evidence`, `story_conversations`, `story_turns`, `journal_events`, `audit_events`, `projection_outbox`, plus FTS5 entity and source indexes. Story turns carry provider/model provenance, narrative order, the exact context manifest JSON and ID, and the revision used for generation. Branch snapshots copy conversations, turns, rules, and all journal-event versions before allowing branch-local continuation. Journal entries preserve source quotes, participant labels, and exact, ranged, relative, or unknown timing. A correction appends a version; earlier wording and conflicting accounts remain retrievable. Claims and awareness records use relative narrative order to prevent future-knowledge leakage.

The rule evaluator supports one reviewed require/forbid condition per rule. It uses accepted public claims marked known, respects an explicitly declared single-valued predicate, and keeps missing, private, unreviewed, uncertain, or conflicting evidence unknown. It does not compose rules or simulate option assumptions. Journal event accounts are manually recorded and remain personal accounts even when linked to a source. They are not yet extracted into general domain events, linked to canonical entity identities, or used for temporal question answering. Aliases, computed states, scene state deltas, scenario option records, approvals, and generalized valid-time intervals remain target-model items.
