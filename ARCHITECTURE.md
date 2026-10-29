# Architecture Baseline

**Baseline:** LKE Final Product & Architecture Plan v1.1, 17 October 2026.

Lorethra is a Windows-first, local-first, single-user modular monolith with ports and adapters. It ships as one desktop application, backed by a Python API sidecar and a canonical SQLite database. Modules have explicit write ownership and versioned contracts; directory separation alone is not a module boundary.

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

Recorded time, branch revisions, relative narrative order, actor beliefs, revisioned story conversations/turns, a manually curated journal timeline, deterministic rule evaluation, branch-scoped scenario options, reviewed RPG state, and scoped story memories are implemented. Journal accounts support exact, ranged, relative, or unknown time and optional source quotes; date-window filters include only overlapping dated accounts, corrections append history, and branch snapshots retain every version. Rules use accepted public claims marked known and evaluate to satisfied, violated, or unknown. Scenario problems, constraints, evidence links, and two or three options are stored separately from baseline truth; append-only assumption versions produce conditional rule outcomes without changing canonical claims. Story turns store the exact context manifest and revision used for generation. Semantic event extraction and correction links, entity resolution for journal participants, advanced temporal queries, historical RPG-state reconstruction, scenario outcome scoring and model-generated recommendations remain incomplete.

The first model-assisted extraction path accepts local text sources up to 24,000 characters and asks Ollama for entity and claim candidates. Structured output is schema-checked, each item must quote an exact source span, and batches are branch-scoped with model and prompt provenance. Candidates remain proposals. A user must review each one; accepting a claim also requires selecting its canonical subject entity and epistemic status/visibility.

## Local API boundary

The FastAPI adapter binds to loopback, checks the peer address, limits browser origins, and requires a bearer token on data routes. The desktop shell provisions a fresh per-run token through a private process-launch channel. Tauri debug mode runs the Python API from the checkout and permits the Vite origin; release mode launches the bundled sidecar and disables the development origin. Do not expose the API on a LAN interface, add permissive CORS, or accept a token from imported content.

## Providers and frameworks

The story provider registry exposes Ollama, OpenAI API, Claude, Codex app-server, and hosted or locally served Hugging Face models. Provider availability depends on user configuration; an explicitly selected external provider receives the authorized request context. Providers return prose only and cannot write canon. The local Ollama adapter discovers installed models and performs chat against the loopback service. The generation path uses revision-bound context and persists prompt/response turns through the command gateway. Unit and mocked provider checks do not replace a live per-provider, privacy, licensing, packaging, latency or failure-path review. No AI or graph library can write accepted facts directly to canonical tables.

## Current implementation boundary

Implemented: SQLite schema v14; workspace and snapshot-branch isolation; source-linked knowledge, journal, scenario and extraction workflows; immutable world versions and adventures pinned to those versions; canonical character sheets, deterministic d20 checks, reviewed state proposals, revisioned turns, scoped memories and threads, NPC profiles, local assets, map locations and travel; `.lke-world` and `.lke-adventure` import/export; and MNO `.mno-world` v1 / `.mno-adv` v2 conversion and import. MNO transcript roles and author-only private fields are preserved without becoming authorized context; world-cast NPCs are added only by explicit user action. The UI keeps the transcript central, places resume cards first, and collapses setup and optional RPG panels. It includes a local reader/print view, character-memory tools, provider/model selection, context inspection, backup/restore, and the existing Knowledge, Journal and Scenario workflows. Canonical writes remain gateway-owned with revisions, audit and recovery.

Not yet release-verified or complete: clean-machine Windows installation and native desktop launch; live provider and browser acceptance; map authoring beyond imported coordinates; searchable world/adventure libraries and a final adventure review step; semantic memory extraction, correction/supersession and historical RPG-state reconstruction after edits; explicit NPC knowledge/relationship scopes and reviewed simulation behavior; generated/selectively revised images and fuller page-based publishing; PDF/Office ingestion; scenario outcome scoring; and separate-device recovery. See [acceptance status](docs/ACCEPTANCE_MATRIX.md).
