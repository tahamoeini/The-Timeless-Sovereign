# Architecture Decisions

This file records decisions made against the LKE v1.1 baseline. Unverified choices stay marked as such.

## ADR-001 — Reset to one LKE product

**Decision:** replace the previous Story Studio repository contents with a clean LKE structure on `master`.

**Reason:** the agreed product is one shared knowledge and memory engine with Story Studio as its first full experience. Existing assets and implementation are retained in Git history for recovery, not copied into the new product without a reuse review.

## ADR-002 — SQLite is canonical

**Decision:** SQLite owns canonical workspaces, branches, entities, claims, relations, evidence, sources, revisions, and audit. FTS and future graph/vector indexes are projections.

**Reason:** it gives a small local installation one durable source of truth and makes export and recovery independent of third-party graph or model services.

## ADR-003 — All writes pass through a command gateway

**Decision:** use validated commands with expected revisions, idempotency keys, branch scope, actor, and reason. Commit the record change, revision, audit event, and outbox atomically.

**Reason:** model output, graph gestures, importers, and agents must not silently become canonical truth.

## ADR-004 — Snapshot branches for v0.1

**Decision:** copy a branch snapshot at a specific parent revision, then keep its records independent. No automatic branch merge.

**Reason:** scenario experimentation must never mutate the main story or knowledge state implicitly.

## ADR-005 — Portable Python core; FastAPI adapter

**Decision:** keep domain and persistence code in the standard-library Python core, with FastAPI as the local HTTP adapter dependency.

**Reason:** core integrity tests run without network access or a model runtime; API and desktop packaging can be validated separately.

## ADR-006 — Baseline UI and adapter choices

**Decision:** React + TypeScript and Tauri 2 are the desktop direction; Ollama is the default local-model adapter; Docling and `sqlite-vec` are candidates, not unconditional core dependencies.

**Reason:** this follows the v1.1 plan while keeping heavyweight extraction and retrieval components replaceable. Windows packaging and local hardware suitability still need evidence.

## ADR-007 — Proposed open-source license

**Decision:** Apache-2.0 for this reset repository, subject to a final contributor/ownership review before public release.

**Reason:** this is the license proposed in the product baseline and is compatible with the intended permissive dependency preference.

## ADR-008 — Story output remains a revision-bound proposal

**Decision:** persist each user prompt and local-model response as branch-scoped conversation history through the command gateway. Store the exact actor-aware context manifest and source revision used for generation with the response. Generated prose does not update canonical claims, relations, character beliefs, or world state.

**Reason:** conversations must survive restarts and branch locally while remaining auditable. Keeping the manifest beside the prose makes later review possible without treating model output as verified knowledge. Live Ollama generation and character-agency compliance still require runtime evaluation.

## ADR-009 — Context sharing starts with an inspectable local package

**Decision:** export an actor-aware context manifest as a versioned local JSON file containing the workspace, branch, source revision, included facts, and exclusions. Do not send it to an external provider from this flow.

**Reason:** this makes the current context portable while preserving user control over whether and where to share it. Versioned transcript import is implemented as a local archive that stays separate from canon and story turns. External provider authentication and per-message redaction remain unimplemented integrations.

## Deferred decisions

The exact document parser, embedding model, GraphRAG integration, external OpenAI/Codex path, minimum hardware, agent safe-apply policy, and final backup container remain open until their evaluation criteria and packaging tests are run. See [the integration register](docs/INTEGRATION_REGISTER.md).
