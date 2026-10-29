# Changelog

This file is the readable change history for Lorethra. The 2026-10-29 section describes this implementation branch relative to its master base. The earlier section moves dated implementation notes that previously lived in the acceptance matrix; test counts there refer to historical source snapshots and are not current schema-v17 results.

## 2026-10-29 — Current implementation branch

### Commit map

| Conventional commit | Contents |
|---|---|
| feat(lorethra): expand RPG mechanics, continuity, and libraries | Application code, schema migrations, and focused backend/API tests |
| docs: consolidate project guides and changelog | Current status, acceptance evidence, documentation map, contracts, UX decisions, and this changelog |

### RPG authoring and deterministic play

- Added world-pinned point-buy character creation. Each world version can define baselines, bounds, costs, budgets, below-baseline refunds, and whether points may remain unspent. The API preflights the allocation and the gateway validates it again before creating the isolated adventure sheet.
- Added explicit exceptional-ability definitions and branch-local activation state. The world version records effects, declared costs/cooldowns, capabilities, limitations, and unresolved aspects. Undeclared costs or restrictions are not invented.
- Added world-pinned d20, custom dice, narrative-only, and hybrid mechanics, with difficulty and encounter definitions, skill ranks, and manual/automatic/hybrid experience. The API generates dice and gateway code validates and records the deterministic result with a rule snapshot.
- Added reviewable setup and play surfaces for mechanics, abilities, experience, and starting attributes. Added a bounded, validated local world cover image with alt text.

### Continuity and providers

- Editing or hiding a turn now supersedes later turns from canonical transcript order. Historical RPG reconstruction covers supported character-sheet, accepted NPC-profile, and map-location changes while preserving direct player edits.
- Adventure scenes create sourced, actor-scoped event-memory proposals that wait for review. Stale source turns exclude their memories from later retrieval.
- Added provider-matched consent checks to external generation, retry, and memory requests. Remote context removes non-public claims, author notes, private profiles, actor-scoped facts, unshared or unreviewed memories, and unclassified lore or thread data.
- Propagated cancellation to Ollama, hosted HTTP, and Codex app-server adapters. Tested cancellation closes local work before canonical commit; idempotent replay covers a response lost after a successful commit. A hosted service may still continue processing or billing after Lorethra closes its request.
- Added context visibility metadata needed for consistent local and external privacy filtering.

### Portable worlds, adventures, and libraries

- Added checksummed LKE v2 world and adventure manifests, independent checksums for decoded adventure images, validated v1 upcasts, bounded API request bodies, and stricter package/image validation.
- Added export previews and public, shareable, selected-content, and confirmed full-private adventure export modes. Adventure imports validate and commit the world, branch snapshot, and adventure atomically. Private context manifests and provider credentials are not packaged.
- Updated MNO adventure conversion to accept matching LKE v1 or v2 world packages.
- Added schema-v17 world/adventure archive timestamps and library indexes. Added world duplication, archive/restore, adventure rename/status/archive/restore, and a guard preventing new adventures from archived worlds.
- Added optional local world covers, with JPEG/PNG/WebP validation and a 64 KiB limit. Pillow is now a runtime dependency so image bytes are decoded before storage.
- Revised the library around persistent search, optional filters and sorting, result counts, empty-state reset, visible resume/use actions, and maintenance controls under “More”. Added responsive sizing and focus indicators for narrow desktop windows.

### Tests and validation in this branch

- Added focused tests for character creation, exceptional abilities, configurable mechanics, and story library lifecycle; expanded package, API, provider, continuity, migration, and backup/restore coverage.
- The current frontend production build passed TypeScript checking and Vite bundling.
- A local browser check verified that searching a 32-adventure library returns the matching result and count. At a 700 × 900 viewport, compact navigation and library controls remained usable.
- The full backend suite was not rerun after schema v17 in this continuation. Full lifecycle browser acceptance, hostile-file UI checks, live provider behavior, current-source Windows packaging, clean-machine launch, and separate-device recovery remain open. See docs/PROJECT_STATUS.md and docs/ACCEPTANCE_MATRIX.md.

### Documentation

- Consolidated the enhancement plan, platform audit, and backlog status into docs/PROJECT_STATUS.md.
- Consolidated research, RPG implementation, and validation procedures into docs/agents/WORKFLOW_GUIDE.md.
- Merged browser test setup and script evidence into tests/README.md.
- Merged the world package contract into docs/contracts/PORTABLE_PACKAGES.md and removed superseded or unreferenced guidance files.
- Rewrote README.md and docs/README.md as a short product entry point and source-of-truth index. Updated schema and command contracts to v17.

## Project milestones recorded before this branch

These entries summarize dated evidence retained from the previous acceptance notes. Counts refer to the source revision used at the time.

### 2026-10-29 — Continuity, memory, and turn history

- Added source-turn-linked, actor-scoped memory proposals, stale-source review protections, and retry context bounded by the saved manifest and current authorization.
- Editing or hiding a transcript turn superseded downstream turns from canonical order; prior edits remain immutable history.
- Focused continuity/retrieval runs recorded 46, 51, and 24 passing tests. An earlier 57-test attempt had 12 migration/backup errors because Windows denied temporary-directory access; those tests were not counted as passing.

### 2026-10-29 — Desktop development setup

- Added generated desktop icon assets and explicit Windows/Linux bundle paths after a WSL build exposed missing icons.
- Documented OS-specific optional npm packages and the need to reinstall when switching Windows/WSL in one checkout.
- Fixed the debug Vite-origin allowlist mode and configured Tauri debug mode to launch the Python source API while release mode uses the bundled sidecar.
- These changes still require current Windows/WSL runtime and installed-desktop acceptance.

### 2026-10-29 — Worlds, packages, MNO, and recovery

- Added LKE world/adventure package previews and import/export, MNO world v1 and adventure v2 conversion, source-role and author-private handling, image decoding, package checksums, and atomic adventure import.
- Validated the supplied MNO pair through the gateway and authenticated ASGI path: 7 stats, 9 trackers, 15 world NPC templates, 85 messages, 7 map locations, 2 images, and 8 author-only thought/meta messages. This did not exercise MNO gameplay or the Lorethra browser import flow.
- Recorded backend milestones of 145, 162, and 170 passing tests for the source revisions at those points. The later runs included migration, package integrity, decoded image checks, provider consent/redaction, and restore comparison across RPG records and assets.

### 2026-10-29 — Point-buy, abilities, and mechanics

- Point-buy and exceptional-ability milestones recorded 182 passing backend/API tests. Browser checks covered bounded allocation and repeated activation of an unlimited Time Stop ability against a mocked local API.
- Schema v16 added world-pinned dice, resolution modes, difficulty, skills, experience, and immutable mechanics-check history. A 185-test backend/API run and authenticated browser flow covered a custom 2d6 adventure, saved check history, skill rank, XP, reload persistence, migration, and package round-trip.
- The MSI/NSIS and sidecar evidence was built against schema v15 and became stale after later schema changes. It does not establish current installer or clean-machine acceptance.

### 2026-10-29 — Earlier native Windows build evidence

- A prior schema-v15 sidecar and Tauri build produced MSI and NSIS installers. The sidecar smoke checked loopback health, bearer-token enforcement, isolated SQLite persistence, Unicode data, and audit writes.
- Installer UI, a visible desktop window, clean-machine setup, restart persistence, current schema packaging, and separate-device recovery were not verified by that build.
