# Product Definition

## Product

Living Knowledge Engine (LKE) is a local-first knowledge and memory workspace. Its first complete experience is Story Studio; the same canonical core also supports Knowledge Explorer, Journal & Memory, and Decision & Scenario Lab.

## v0.1 outcome

A Windows user can create an isolated workspace; import and preserve sources; review evidence-backed knowledge proposals; browse and correct entities and relationships; build a story world and continue a narrative with persistent, character-scoped memory; explore a branch without changing the primary world; review proposed changes; and reopen, export, back up, and restore the project. A paid cloud API is never required for the primary path.

The release is one integrated product, not a set of disconnected demonstrations. The complete outcome is intentionally constrained by workflow count and domain breadth; workspace ownership, evidence, revision history, branch isolation, and recoverability are not optional shortcuts.

## Core workflows

1. **Knowledge:** import a source, preserve its exact content and fingerprint, extract candidates with anchors, review them, and commit approved knowledge through the command gateway.
2. **Story Studio:** create or choose a world, build a protagonist, then start or resume an isolated adventure. Play with a persistent transcript, visible d20 checks and character trackers; review generated state changes before they enter the adventure's canon.
3. **Journal:** import dated notes, preserve conflicting accounts and original wording, then produce an evidence-linked account of how the user's record changes over time.
4. **Scenario:** record a question, options, evidence, constraints, and assumptions; compare conditional outcomes on an isolated branch.
5. **Recovery:** close and reopen a workspace, export an exchange, create a full backup, restore it to a different location, and compare canonical content and history.

## Product principles

- The user owns canonical data independently of any model or provider.
- The SQLite store is authoritative; graphs, indexes, embeddings, and summaries are rebuildable projections.
- Extracted or generated content remains proposed until an allowed command is reviewed and committed.
- Story canon, a user's personal account, research claims, and scenario assumptions have different authority rules.
- Conflicts retain their sources and are shown; last-write-wins is not a truth policy.
- Cloud transfer is off by default and requires explicit, scoped consent.
- Agent access is bounded by workspace, operation class, budget, and stopping conditions.
- Simple and Advanced UI modes change available controls, not the meaning of data.

## Out of scope for v0.1

Multi-user collaboration, automatic conflict merges, unrestricted shell or network agents, unattended world simulation, guaranteed predictions, and a fixed commitment to any GraphRAG framework are excluded. They may be evaluated later without changing the core ownership and command boundaries.

## Release acceptance

Release requires the integrity gates in [the acceptance matrix](docs/ACCEPTANCE_MATRIX.md) and the twelve-item checklist in [Definition of Done](docs/ACCEPTANCE_MATRIX.md#definition-of-done). The current implementation status is tracked there; this product definition does not claim those gates have all passed.
