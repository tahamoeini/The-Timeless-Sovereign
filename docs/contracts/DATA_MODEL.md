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
| Belief / Knowledge | What an actor knows, believes, denies, or lacks | Actor- and awareness-order-scoped |
| Rule | Constraint or evaluable condition | Domain-owned |
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

## SQLite v1 implementation

The current schema provides `workspaces`, `branches`, `revisions`, `commands`, `entities`, `relations`, `claims`, `actor_beliefs`, `sources`, `evidence`, `audit_events`, `projection_outbox`, plus FTS5 entity and source indexes. Claims and awareness records have a relative narrative-order field for preventing future-knowledge leakage. It does not yet implement the full target tables for aliases, events, states, conversations, rules, scenarios, approvals, or valid-time intervals. Those are not to be represented as completed merely because the concepts appear in this contract.
