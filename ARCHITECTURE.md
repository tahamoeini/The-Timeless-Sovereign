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

Recorded time and branch revision are implemented in the initial core. Valid time, awareness time, narrative order, richer temporal ranges, state, actor beliefs, conversations, approvals, and scenario domain records remain part of the target model and must be implemented with their acceptance tests before the corresponding workflows are called complete.

## Local API boundary

The initial FastAPI adapter binds to loopback, checks the peer address, limits browser origins, and requires a bearer token on data routes. The desktop shell must provision a fresh per-run token through a private sidecar launch channel. Do not expose the API on a LAN interface, add permissive CORS, or accept a token from imported content.

## Providers and frameworks

Ollama is the planned local provider. External providers, Codex app-server, document parsers, vector search, and GraphRAG frameworks are optional adapters and remain unverified until capability, privacy, packaging, license, and failure behavior are tested. No AI or graph library can write directly to canonical tables.

## Current implementation boundary

Implemented: SQLite schema v1, workspace creation, branch snapshots, command gateway for entities, relations, claims, text sources and evidence, FTS search, revisions, append-only audit, transactional outbox, and a loopback API adapter.

Not yet implemented: desktop shell, source-file ingestion and extraction review, graph/matrix/timeline UI, context compiler, Ollama calls, story and journal workflows, scenario evaluator, exchange import/export, full backup/restore, and packaged Windows installation. See [acceptance status](docs/ACCEPTANCE_MATRIX.md).
