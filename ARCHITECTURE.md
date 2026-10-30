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

Recorded time, branch revisions, relative narrative order, actor beliefs, revisioned story conversations/turns, a manually curated journal timeline, deterministic rule evaluation, branch-scoped scenario options, reviewed RPG state, scoped story memories, and selected historical reconstruction are implemented. Journal accounts support exact, ranged, relative, or unknown time and optional source quotes; date-window filters include only overlapping dated accounts, corrections append history, and branch snapshots retain every version. Rules use accepted public claims marked known and evaluate to satisfied, violated, or unknown. Scenario problems, constraints, evidence links, and two or three options are stored separately from baseline truth; append-only assumption versions produce conditional rule outcomes without changing canonical claims. Story turns store the exact context manifest and revision used for generation. Historical edits rebuild supported RPG sheet, NPC profile, and map state from surviving records while preserving direct player edits; broader event, relation, military, and summary reconstruction remains incomplete. Semantic event extraction and correction links, entity resolution for journal participants, advanced temporal queries, scenario outcome scoring and model-generated recommendations also remain incomplete.

The first model-assisted extraction path accepts local text sources up to 24,000 characters and asks Ollama for entity and claim candidates. Structured output is schema-checked, each item must quote an exact source span, and batches are branch-scoped with model and prompt provenance. Candidates remain proposals. A user must review each one; accepting a claim also requires selecting its canonical subject entity and epistemic status/visibility.

## Local API boundary

The FastAPI adapter binds to loopback, checks the peer address, limits browser origins, and requires a bearer token on data routes. The desktop shell provisions a fresh per-run token through a private process-launch channel. Tauri debug mode runs the Python API from the checkout and permits the Vite origin; release mode launches the bundled sidecar and disables the development origin. Do not expose the API on a LAN interface, add permissive CORS, or accept a token from imported content.

## Providers and frameworks

The story provider registry exposes Ollama, OpenAI API, Claude, Codex app-server, and hosted or locally served Hugging Face models. Provider availability depends on user configuration. External story generation, retries, and memory queries require provider-matched consent at the authenticated API; remote context is filtered to public claims and shared reviewed memories, with author notes, private profiles, actor-scoped facts, unshared memories, unclassified lore/thread context, and imported MNO lorebook references removed. Consent preferences are stored per provider in the client and can be revoked; the backend still requires a matching consent field for every outbound request. Providers return prose only and cannot write canon. The local Ollama adapter discovers installed models and performs chat against the loopback service. The generation path uses revision-bound context and persists prompt/response turns through the command gateway. Unit and mocked provider checks do not replace live per-provider, retention-policy, licensing, packaging, latency, cancellation or failure-path review. No AI or graph library can write accepted facts directly to canonical tables.

## Current implementation boundary

Implemented: SQLite schema v17; workspace and snapshot-branch isolation; source-linked knowledge, journal, scenario and extraction workflows; immutable world versions and adventures pinned to those versions; canonical character sheets, reusable and adventure-local revisioned character identity notes, world-defined point-buy setup, world-pinned d20/custom-dice/narrative-only/hybrid mechanics, deterministic skill and difficulty checks, manual/automatic/hybrid experience, explicitly defined exceptional abilities with separate activation state, reviewed state proposals, revisioned turns, scoped memories and threads, NPC profiles, local assets, map locations and travel; world/adventure rename, status, duplicate and archive/restore lifecycle; a local-Ollama world-draft workflow with strict output and location-reference checks, optional world cover images, and structured public opening scenes; checksummed `.lke-world` v2 and `.lke-adventure` v2 import/export with validated v1 upcasts; and MNO `.mno-world` v1 / `.mno-adv` v2 conversion and import; editable, versioned lorebook activation and keyword rules with inspectable per-turn context selection. Character identity notes are descriptive local context, remain attached to the selected branch actor, preserve revision history, and are removed at the hosted-provider boundary. World Architect results are previewed and applied to editable fields before the user saves them through the gateway. Opening scenes are reviewed in adventure setup, pinned to a world version, and included only in the first generated response context. Mechanics rolls, skill bonuses, difficulty targets and experience totals are calculated by gateway/API code and do not depend on model output. Ability costs and cooldowns apply only when the pinned world definition explicitly declares them; no implicit mana, d20, or level constraints are inferred. MNO transcript roles and author-only private fields are preserved without becoming authorized context; world-cast NPCs are added only by explicit user action. The UI keeps the transcript central, places resume cards first, shows library search with optional filters and sorting, and collapses setup, maintenance, and optional RPG panels. It includes a local reader/print view, character-memory tools, provider/model selection, context inspection, backup/restore, and the existing Knowledge, Journal and Scenario workflows. Canonical writes remain gateway-owned with revisions, audit and recovery.

Not yet release-verified or complete: clean-machine Windows installation and native desktop launch; full browser, RTL, accessibility, and live-provider acceptance; whether hosted providers stop processing or billing after Lorethra closes a cancelled request; map authoring beyond imported coordinates; hostile-file browser acceptance for packages; the complete world/adventure lifecycle and final adventure review in a browser; semantic memory extraction, correction/supersession, and broader historical state reconstruction; explicit NPC knowledge/relationship scopes and reviewed simulation behavior; generated/selectively revised images and fuller page-based publishing; PDF/Office ingestion; scenario outcome scoring; and separate-device recovery. See [acceptance status](docs/ACCEPTANCE_MATRIX.md) and the [project status](docs/PROJECT_STATUS.md).

Worlds may pin an optional `character_creation` contract in each immutable version. It defines the point budget, unspent/refund options, and each attribute's baseline, bounds, and increase cost. The UI reviews the final allocation before start; the gateway checks it against the exact pinned world version before creating the adventure branch. The canonical adventure sheet stores the validated attributes while trackers remain separate. Worlds without this contract retain the legacy baseline-sheet behavior. This contract does not make character attributes into temporary resources or extraordinary abilities.

World versions may also pin explicit exceptional-ability definitions. Adventure sheets store their activation state separately from stats and trackers, and package import/export plus branch/history reconstruction preserve both. The gateway validates only the costs and cooldowns the definition states, so a demonstrated ability with no declared mana cost or cooldown remains usable at zero mana and outside the d20 check path.
