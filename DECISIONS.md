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

**Reason:** this makes the current context portable while preserving user control over whether and where to share it. Versioned transcript import is implemented as a local archive that stays separate from canon and story turns. External story requests now require provider-matched consent at the API and remove non-public claims, author notes, private profiles, unshared memories, and unclassified lore/thread context. Consent preferences are stored per provider in the client and can be revoked. Cancellation events now reach provider adapters; active HTTP responses are closed and Codex's ephemeral process is terminated. Verify live behavior because hosted providers may continue processing or bill after Lorethra closes a request.

## ADR-010 — World-pinned point-buy character creation

**Decision:** a world version may define an optional typed character-creation contract for attribute budgets, per-stat baseline/bounds/cost, unspent points, and below-baseline refunds. The adventure-start UI previews the resulting sheet, and the command gateway validates that sheet against the exact world version before branch creation. Trackers and extraordinary abilities remain separate data.

**Reason:** character creation needs flexible world-specific mechanics without granting a client or model authority to bypass bounds or point totals. Pinning the rules to the immutable world version keeps imported/replayed adventures deterministic. Legacy worlds without the optional contract keep their existing start behavior.

## ADR-011 — Explicit world-pinned exceptional abilities

**Decision:** store extraordinary abilities in immutable world-version definitions and keep their adventure activation state separate from attributes and trackers. Definitions describe activation, effects, explicit costs/cooldowns, duration/range, interactions with ordinary magic, demonstrated capabilities, confirmed limitations, and unresolved aspects. The gateway enforces only costs and cooldowns the definition explicitly declares; an ability with no stated cost or cooldown has neither. Ability activation does not implicitly require d20, mana, or level checks.

**Reason:** imported and authored settings must preserve exceptional capabilities without translating them into assumptions from a familiar RPG system. Pinning definitions to the adventure's world revision and revisioning activation state keeps behavior portable, auditable, and historically reconstructable.

## ADR-012 — World-pinned configurable game mechanics

**Decision:** an immutable world version may define deterministic d20 or bounded custom dice, narrative-only or hybrid resolution, difficulty and encounter lists, skills/proficiency, and manual/automatic/hybrid experience. The adventure copies its starting skills and XP state and resolves checks only against the pinned profile. The API generates rolls; gateway code validates and calculates results. Models can narrate a saved result but cannot choose rolls, alter arithmetic, award XP, or modify skills.

**Reason:** worlds can use different mechanics without changing the legacy d20 default or affecting adventures already in progress. Persisting rule snapshots beside immutable check records keeps history and portable packages interpretable after later world revisions.

## Deferred decisions

The exact document parser, embedding model, graph-retrieval framework, minimum hardware, agent safe-apply policy, and final backup container remain open until their evaluation criteria, Windows packaging, offline behavior, licensing, and recovery effects are reviewed. Optional dependencies must remain replaceable and cannot own canonical data. Current platform priorities and release gaps are tracked in [Project status](docs/PROJECT_STATUS.md).
