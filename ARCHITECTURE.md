# Architecture Baseline

**Baseline:** LKE Final Product & Architecture Plan v1.1, 17 October 2026.

LKE is a Windows-first, local-first, single-user modular monolith with ports and adapters. It ships as one desktop application, backed by a Python API sidecar and a canonical SQLite database. Modules have explicit write ownership and versioned contracts; directory separation alone is not a module boundary.

```text
Desktop shell (Tauri 2) + React/TypeScript
        │ authenticated loopback API
Application and domain services
        ├── Knowledge / review / commands
        ├── Story / NPC / rules
        ├── Journal / memory
        ├── Scenario / branch evaluation
        └── Context compiler / provider gateway
        │
Canonical core (SQLite)
        ├── sources, evidence, entities, claims, relations
        ├── branches, revisions, append-only audit
        └── transactional projection outbox
        │
Rebuildable projections: FTS, graph, summaries, embeddings
        │
Adapters: filesystem parsers, Ollama, optional external providers
```

## Ownership and write paths

The source manager owns immutable source versions. The extraction pipeline owns only candidates. The knowledge core owns approved records and their revisions. Search and graph modules own projections only. Narrative and scenario modules submit proposed changes to the command gateway. The AI gateway owns provider sessions and capabilities, never canonical facts. The desktop shell coordinates user actions and owns no domain truth.

Every canonical write follows `Propose → Validate → Authorize → Commit → Revision → Invalidate/Rebuild`. The data mutation, revision, audit event, and projection outbox entry commit together. Optimistic concurrency, idempotency, workspace checks, and branch checks are enforced at the gateway.

## Data and time

SQLite is the only source of truth. FTS5 is a rebuildable text projection. A branch is an immutable snapshot at a parent revision followed by branch-local writes; changing a branch does not modify its parent. A branch promotion is a distinct, reviewed operation. v0.1 does not auto-merge conflicting branches.

Recorded time, branch revisions, relative narrative order, actor beliefs, revisioned story conversations/turns, a manually curated journal timeline, deterministic rule evaluation, and branch-scoped scenario options are implemented. Journal accounts support exact, ranged, relative, or unknown time and optional source quotes; date-window filters include only overlapping dated accounts, corrections append history, and branch snapshots retain every version. Rules use accepted public claims marked known and evaluate to satisfied, violated, or unknown. Scenario problems, constraints, evidence links, and two or three options are stored separately from baseline truth; append-only assumption versions produce conditional rule outcomes without changing canonical claims. Story turns store the exact context manifest and revision used for local generation. General event extraction, entity resolution for journal participants, temporal question answering, scene state deltas, approvals, scenario outcome scoring and model-generated recommendations remain part of the target model.

The first model-assisted extraction path accepts local text sources up to 24,000 characters and asks Ollama for entity and claim candidates. Structured output is schema-checked, each item must quote an exact source span, and batches are branch-scoped with model and prompt provenance. Candidates remain proposals. A user must review each one; accepting a claim also requires selecting its canonical subject entity and epistemic status/visibility.

## Local API boundary

The FastAPI adapter binds to loopback, checks the peer address, limits browser origins, and requires a bearer token on data routes. The desktop shell provisions a fresh per-run token through a private sidecar launch channel. The bundled API sidecar was built and smoke-tested for loopback health and bearer-token enforcement; the Tauri host itself has not been compiled or packaged on this machine. Do not expose the API on a LAN interface, add permissive CORS, or accept a token from imported content.

## Providers and frameworks

Ollama is the local provider adapter. It discovers local models and performs non-streaming chat against the loopback service. The generation path uses actor-aware, revision-bound context and persists prompt/response turns through the command gateway. The adapter is unit-tested with a simulated service; no live Ollama generation was available during validation. External providers, Codex app-server, document parsers, vector search, and GraphRAG frameworks remain unverified until capability, privacy, packaging, license, and failure behavior are tested. No AI or graph library can write accepted facts directly to canonical tables.

## Current implementation boundary

Implemented: SQLite schema v7, workspace creation, branch snapshots including story, external exchanges, journal, rule, scenario, extraction-batch, candidate, and evidence-link records, explicit fast-forward promotion into an unchanged direct parent, command gateway for entities, relations, claims, rules, text sources, evidence, conversations, story turns, external transcript segments, journal accounts, scenario options and assumption versions, branch-scoped model-assisted entity/claim candidate extraction and review, FTS search, actor-aware context compilation, revision-bound context export, local Ollama chat and structured-output adapter, revisions, append-only audit, transactional outbox, offline backup/restore plus authenticated desktop backup/download and validated restore routes, and a loopback API adapter. The exchange bridge stores untrusted transcript segments separately, deduplicates by transcript identity and content hash, detects missing turn ranges and conflicting overlaps, and surfaces stale context for review. The UI has a concept map, a relationship matrix, an audited editor for branch-scoped entity, relationship, and claim corrections, a revision history with before/after command results, a journal source reader and dated/uncertain event timeline, deterministic three-valued rule checks, scenario record comparison and full branch command review before promotion, conditional rule outcomes for accepted option assumptions, a source-quote-based extraction review flow, external exchange review, and full-database backup/restore controls. Interactive exchange, promotion, correction, and API-boundary verification remain pending.

Not yet implemented: completed Tauri desktop package, PDF/Office ingestion, chunked or long-source extraction, model-assisted relation/event/rule/style extraction, general event/state and advanced timeline projections, story state deltas, transcript export and redaction controls, scenario outcome scoring and model-generated recommendations, separate-device restore drill, live-model quality/performance validation, and clean-machine Windows installation. See [acceptance status](docs/ACCEPTANCE_MATRIX.md).
