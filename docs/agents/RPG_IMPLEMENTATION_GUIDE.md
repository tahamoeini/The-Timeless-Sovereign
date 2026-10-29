# Story Studio RPG Implementation Guide

Use this guide when extending the user-approved Story Studio RPG plan. It is repository guidance for coding agents, not an executable skill or authority to expand product scope.

## Read before changing code

Read `AGENTS.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `docs/STORY_STUDIO_ENHANCEMENT_PLAN.md`, `docs/contracts/DATA_MODEL.md`, `docs/contracts/COMMAND_CONTRACTS.md`, `docs/contracts/NARRATIVE_RULES.md`, `docs/contracts/MNO_IMPORT.md`, `docs/ACCEPTANCE_MATRIX.md`, and this guide. Keep the local-first, single-user Windows product and existing Lorethra workflows intact.

## Product path

Keep the ordinary path short: continue an adventure or create/import a world, choose a protagonist, then play. Put setup, imports and libraries behind concise disclosures and keep the transcript/composer central. Keep map, NPC, memory and gallery details contextual. Preserve existing conversations as unbound stories; do not rewrite their turns to make them look like RPG adventures.

## Canon and privacy rules

- SQLite canonical rows are authoritative. Search, graphs, manifests, summaries, and other derived data must be rebuildable.
- Every canonical write goes through `CommandGateway`; UI and providers must never write canonical tables directly.
- A world revision is immutable. An adventure pins one world revision and has its own branch snapshot, conversation, and RPG state. Editing the world cannot change an existing adventure.
- The built-in d20 result is calculated by gateway code from a user-facing die roll, the current sheet modifier, and the visible target. The model can narrate the recorded outcome but cannot supply or alter its arithmetic.
- Generated state changes remain proposals. Human review commits an accepted change with expected-revision and current-state checks. Pending or rejected proposals never enter authorized model context.
- Apply workspace, branch, actor, review, visibility, and time permissions before any relevance ranking. Extend the existing context compiler and manifest; do not add a second canonical memory store.
- Treat imported packages and provider output as untrusted. Preview package versions, provenance, IDs, and paths before import. Never import provider credentials or execute imported prompts, formulas, scripts, or HTML.
- For MNO imports, preserve narrator/NPC/action/check/thought/meta roles. Thoughts and meta remain collapsed author-only transcript content and are excluded from future model context and reader/print output. NPC secrets and life records stay in private profile data; check narration is never reconstructed as a die roll.
- MNO world-cast templates enter an adventure only after explicit selection. Their imported secrets remain author-only and NPC simulation is off by default.
- Preserve audit history, idempotency, optimistic revision checks, branch promotion rules, and the existing full backup/restore path.

## Implemented baseline

Schema v14 includes world versions, isolated adventures, character sheets, checks and reviewable state proposals, turn edit history, scoped story memories and threads, NPC profiles, local image assets, coordinate-backed map locations, imported turn-role metadata and immutable MNO source archives. The Story screen exposes those foundations, a reader/print view and selectable Ollama, OpenAI, Claude, Codex and Hugging Face text-provider adapters. `.lke-world`, `.lke-adventure`, `.mno-world` v1 and `.mno-adv` v2 preview/import flows are implemented. Review source and the acceptance matrix before treating any workflow as release-ready.

The context includes pinned public world data, current approved RPG state, actor-filtered memories, narrator guidance and bounded older-turn recall. Sourced memories are omitted when their source turn changed or is outside the selected transcript history. MNO lore enters only as bounded narrator reference, after the current query/location match; it is not proof of character knowledge. MNO source archives and private NPC fields never enter the generation context. Remaining gaps include canonical state reconstruction after historical edits, semantic memory extraction and correction links, profile/relationship knowledge scoping, full searchable libraries and setup review, provider/browser/Windows acceptance, and tested image-generation/publishing workflows. See the platform audit for current evidence.

## Work sequence for remaining scope

1. Verify schema v14 on an existing v13 database and run full backend coverage. Complete browser tests for MNO world-first import, adventure import/export, collapsed setup, NPC cast selection and coordinate travel.
2. Finish distinct searchable/filterable world and adventure libraries, the final hero/setup review and accessible resume/navigation. Retain duplicate-by-default behavior and do not expose technical branch IDs on the normal path.
3. Reconstruct RPG state and invalidate derived summaries after historical turn changes; preserve the selected turn's authorized manifest when retrying an older scene.
4. Extend NPC identity and knowledge scoping with explicit alias matching. Keep world cast opt-in. Only expand off-screen simulation after reviewed proposals, actor permissions and the five-turn/two-NPC limits pass deterministic tests.
5. Add semantic event extraction and correction/supersession links to the existing reviewable memory records; extend the bilingual evaluation corpus and context inspector. Keep current Notes, Situation, Open Threads and event review flows.
6. Improve authored map editing and accessibility. Imported MNO coordinates are rendered schematically; do not claim geographic scale, infer distance units or make generated places canon before review.
7. Continue package hardening: hostile fixture tests, full backup/restore with imported archives and images, and Windows browser/desktop acceptance. `.lke-world`, `.lke-adventure` and the MNO adapter are implemented, but cross-device and UI behavior are not yet proven.
8. Extend publishing with page/scene revision links, selective image regeneration, provenance and provider cost/cancellation controls. Current local uploads and print reader are foundations. Video, public catalogs, accounts and community features remain deferred.

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
