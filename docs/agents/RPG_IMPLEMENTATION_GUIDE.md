# Story Studio RPG Implementation Guide

Use this guide when extending the user-approved Story Studio RPG plan. It is repository guidance for coding agents, not an executable skill or authority to expand product scope.

## Read before changing code

Read `AGENTS.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `docs/STORY_STUDIO_ENHANCEMENT_PLAN.md`, `docs/contracts/DATA_MODEL.md`, `docs/contracts/COMMAND_CONTRACTS.md`, `docs/contracts/NARRATIVE_RULES.md`, `docs/ACCEPTANCE_MATRIX.md`, and this guide. Keep the local-first, single-user Windows product and existing LKE workflows intact.

## Product path

Keep the ordinary path short: create or choose a world, build or choose a protagonist, start or resume an adventure, then play. Put less common settings in a world editor or contextual panels. Preserve existing conversations as unbound stories; do not rewrite their turns to make them look like RPG adventures.

## Canon and privacy rules

- SQLite canonical rows are authoritative. Search, graphs, manifests, summaries, and other derived data must be rebuildable.
- Every canonical write goes through `CommandGateway`; UI and providers must never write canonical tables directly.
- A world revision is immutable. An adventure pins one world revision and has its own branch snapshot, conversation, and RPG state. Editing the world cannot change an existing adventure.
- The built-in d20 result is calculated by gateway code from a user-facing die roll, the current sheet modifier, and the visible target. The model can narrate the recorded outcome but cannot supply or alter its arithmetic.
- Generated state changes remain proposals. Human review commits an accepted change with expected-revision and current-state checks. Pending or rejected proposals never enter authorized model context.
- Apply workspace, branch, actor, review, visibility, and time permissions before any relevance ranking. Extend the existing context compiler and manifest; do not add a second canonical memory store.
- Treat imported packages and provider output as untrusted. Preview package versions, provenance, IDs, and paths before any future import. Never import provider credentials.
- Preserve audit history, idempotency, optimistic revision checks, branch promotion rules, and the existing full backup/restore path.

## Implemented baseline

Schema v13 includes world versions, isolated adventures, character sheets, checks and reviewable state proposals, turn edit history, scoped story memories and threads, NPC profiles, local image assets and approved map locations. The Story screen exposes these foundations, a reader/print view and selectable text-provider adapters. Review source and the acceptance matrix before treating any workflow as release-ready.

The context includes pinned public world data, current approved RPG state, actor-filtered memories, narrator guidance and bounded older-turn recall. Sourced memories are omitted when their source turn changed or is outside the selected transcript history. Historical RPG state reconstruction, automatic memory extraction, source-linked summary invalidation, portable world/adventure packages, full publishing workflows and live acceptance remain incomplete. See the platform audit for the complete priority list and verification gaps.

## Work sequence for remaining scope

1. Verify the current schema migration, gateway, API and UI slice with focused tests before extending it. Establish live local-model and browser baselines when the environment supports them.
2. Complete adventure lifecycle safety: duplicate/resume behavior, clean recovery from partially completed setup requests, save and restore, and clear legacy-story handling.
3. Implement a reviewable turn lifecycle. Editing, retrying or deleting a turn must preserve revision history and invalidate dependent context or summaries safely. Cancellation and provider failure must never save partial prose.
4. Build NPC profiles and explicit identity/alias matching. Keep NPC knowledge actor-scoped; add optional off-screen simulation only after its reviewed proposal flow and five-turn/two-NPC limits can be tested.
5. Add the four Memories views (manual Notes, reviewable event memories, rebuildable Situation, editable Open Threads) and a context inspector. Filter permissions before ranking; retain old records and make every exclusion reason inspectable.
6. Add optional location/map suggestions with explicit review and player-selected travel. Suggested geography is not canon until accepted.
7. Add versioned `.lke-world` and `.lke-adventure` packages with bounded parsing, safe paths, duplicate-by-default imports, conflict preview, provenance and replace confirmation.
8. Add publishing after play is stable: selective scene/character assets, a reader, and local print export. Keep provenance, cancellation, cost, language/RTL checks and export preview in scope. Video, public catalogs, accounts, and community features are deferred.

## Required evidence

For each slice, add or update tests at the canonical command boundary and at the authenticated API or UI boundary where behavior crosses it. Cover happy paths, stale revisions, idempotent retries, workspace/branch isolation, rejected and pending proposals, malformed imports, provider failure and recovery. Persian acceptance includes RTL layout, punctuation, mixed Persian/English text, and the installed Vazirmatn font. Do not claim browser, live Ollama, Windows package, or restore-drill coverage from unit tests alone.

Run the focused backend tests with repository-local temporary paths where required:

```powershell
$env:PYTHONPATH = 'backend;.tmp-api-deps'
$env:TEMP = Join-Path (Get-Location) 'TEMP'
$env:TMP = $env:TEMP
.venv\Scripts\python.exe -m unittest tests.unit.test_story_rpg tests.unit.test_database_migrations tests.unit.test_command_gateway tests.unit.test_branch_promotion -v
npm run build
```

Then run the full suite and the required live-model, browser, backup/restore, and Windows desktop acceptance checks available in the environment. Update `docs/ACCEPTANCE_MATRIX.md` with executed evidence and explicit gaps. Do not mark a phase complete because its code compiles.
