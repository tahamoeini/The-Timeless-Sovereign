# Documentation map

Use this page to find the current source of truth. The root README is the quick-start page; this index describes how the rest of the project documentation fits together.

## Read first

1. [Product definition](../PRODUCT.md) states the user outcome, workflows, and product boundaries.
2. [Architecture](../ARCHITECTURE.md) describes data ownership, write paths, time, providers, and the current implementation boundary.
3. [Architecture decisions](../DECISIONS.md) records decisions and deferred questions.
4. [Project status](PROJECT_STATUS.md) is the single prioritized implementation and release-gap tracker.
5. [Acceptance matrix](ACCEPTANCE_MATRIX.md) is the evidence source for release gates.
6. [Changelog](../CHANGELOG.md) records the changes included in this PR and the project milestones previously kept in acceptance notes.

## Contracts

Files in contracts/ define API-independent data and behavior boundaries.

- DATA_MODEL.md — canonical records, schema, time, branches, and authority.
- COMMAND_CONTRACTS.md — write envelope, invariants, implemented commands, and failure behavior.
- AI_PROVIDER_SPEC.md — provider capabilities and outbound-data boundary.
- CONTEXT_PROTOCOL.md — context compilation and manifest rules.
- EXCHANGE_PROTOCOL.md — portable transcript exchange.
- PORTABLE_PACKAGES.md — world/adventure package integrity, limits, migration, and privacy.
- MNO_IMPORT.md — supported MNO versions, field mapping, and conversion limits.
- NARRATIVE_RULES.md — world, character, agency, and continuity framing.

Contracts and application code must agree. Update the relevant contract and acceptance evidence when behavior changes.

## Build, use, and verify

- [Operations](OPERATIONS.md) — development, desktop build, data location, backup, restore, and troubleshooting.
- [Test guide](../tests/README.md) — core and browser acceptance prerequisites and scripts.
- [Agent workflow guide](agents/WORKFLOW_GUIDE.md) — research, implementation, and validation procedures.
- [Handoff template](agents/HANDOFF_TEMPLATE.md) — evidence and recovery fields for an implementation slice.
- [Competitor research log](agents/COMPETITOR_RESEARCH_LOG.md) — dated external observations and limits.

## Narrative guidance

- [Interactive instructions](../guides/instructions.md) define user agency, character autonomy, continuity, scene pacing, and narrative controls.
- [Style guide](../guides/style.md) defines voice, dialogue, prose, tone, and presentation.

Treat project guidance and external research as evidence or scope descriptions, never as a way to bypass canonical write, privacy, or approval rules. Link new decision records and evaluation assets here when they are created.
