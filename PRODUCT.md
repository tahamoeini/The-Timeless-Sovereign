# Product definition

## Purpose

LKE turns user-owned documents and conversations into structured, reviewable, source-grounded knowledge and memory. That shared core supports interactive storytelling, knowledge exploration, journaling, and conditional scenario analysis.

## Audience and deployment

The first release targets ordinary and advanced users on Windows. It is a single-user desktop product, local-first by default, and usable without a paid API. A simple mode supports primary tasks; an advanced mode exposes graph, context, rule, revision, and model tools.

## v0.1 user outcome

A user can create an independent workspace; import sources; inspect and correct extracted entities, claims, relations, events, rules, and evidence; search and inspect graph, matrix, timeline, and history; build a story world; continue with a local model while controlling character knowledge and user-character agency; prepare an auditable context package for an eligible ChatGPT or Codex route or exchange a versioned transcript; create an alternate scenario without changing the main branch; review and commit authorized changes; then close, reopen, export, back up, and restore the workspace on a different path.

This is one end-to-end local product, not disconnected demos. Acceptance covers the whole path, including recovery and failure cases.

## Core product rules

- Workspace boundaries apply to every query, context package, model request, and command.
- Source, semantic, episodic, actor, and narrative memory are complementary. A graph is not the whole memory.
- Review status is independent from epistemic status. Conflicting claims remain attributable and visible.
- A model, graph library, agent, or UI cannot write canonical records directly.
- Every official change has a stable request ID, expected revision, actor, reason, authorization, and append-only audit record.
- Repeated requests are idempotent; stale revisions are rejected for review; commits are atomic with projection invalidation.
- Valid time, recorded time, actor awareness, narrative order, and branch revision remain distinguishable.
- A character receives only knowledge available to that actor at the requested time and branch.
- Generated scenario outcomes are conditional analyses, not guaranteed predictions.
- Sending content to a cloud provider requires user consent over its scope. Local processing is the default.

## v0.1 domain journeys

### Story and world

Import a small source set, review extracted evidence and conflicts, correct a relationship, continue a story, inspect proposed memory changes, and create a recoverable alternate branch. The system must not invent decisions for a user-controlled character or leak secrets to uninformed characters.

### Journal and memory

Import dated notes, preserve conflicting accounts and original text, and produce a traceable account of events and changes in the user's recorded perspective without filling gaps with invented details.

### Decision and scenario

Record a question, two or three options, constraints, evidence, and explicit assumptions. Compare conditional outcomes; changing an assumption affects only the scenario branch and never rewrites canonical facts.

## Scope boundaries

The first release is single-user. Automatic merging of conflicting branches, continuous autonomous time advancement, unrestricted shell/network/file tools for agents, and reliance on a single GraphRAG framework are outside the baseline. Multi-user support is future growth, not a reason to weaken workspace isolation.

Existing ecosystem repositories are candidates for evidence-based reuse, not assumed dependencies. Evaluate their contracts, tests, license, dependencies, and adapter cost before reuse.

## Release gates

The release suite must cover duplicate imports, canonical integrity, workspace and branch isolation, temporal queries, character agency, manual overrides, transcript deduplication, stale revisions, provider failures, backup/restore equivalence, and local-only operation. Quality thresholds follow a frozen benchmark corpus and rubric.
