# Changelog

This file is the readable change history for Lorethra. The 2026-10-29 section describes this implementation branch relative to its master base. The earlier section moves dated implementation notes that previously lived in the acceptance matrix; test counts there refer to historical source snapshots and are not current schema-v17 results.

## 2026-10-29 — Current implementation branch

### Commit map

| Conventional commit | Contents |
|---|---|
| feat(lorethra): expand RPG mechanics, continuity, and libraries | Application code, schema migrations, and focused backend/API tests |
| docs: consolidate project guides and changelog | Current status, acceptance evidence, documentation map, contracts, UX decisions, and this changelog |
| test(story): account for package image revalidation (`5df3b45`) | Updated world-cover validation coverage for the canonical update, stored package, and redacted public-export boundaries |
| ci(windows): build desktop package on pull requests (`851a1b1`) | Run Windows checks, bundled API smoke, MSI/NSIS builds, and artifact upload on pull requests |
| feat(story): streamline adventure discovery and setup (`80095ba`) | Add an always-visible adventure creation action, progressive disclosure for long libraries, clearer wizard steps, and live point-budget guidance |
| docs(status): refresh UX and Windows acceptance evidence (`1968f76`) | Synchronize project status, release gates, operations, and changelog with the verified UI workflow and Windows package |
| feat(story): add local world architect and opening scenes (`98bdbed`) | Add local Ollama drafting, strict semantic checks, human preview/apply, versioned opening scenes, and public package preservation |
| docs(status): refresh current-head Windows evidence (`9b68cd5`) | Record the completed Windows run 43 and its current installer artifact; retain clean-machine desktop and feature-specific acceptance as open |
| fix(packages): validate imported world authoring fields (`9d5d28f`) | Apply bounded/unique location and starting-reference validation to world imports, normalize opening-scene text, and preserve legacy map forms |
| feat(story): cancel local world drafts (`f95de1a`) | Let users stop an in-flight local World Architect request while preserving the no-save draft boundary |
| feat(backup): show restore verification details (`b2a4f16`) | Report the restored workspace count, backup time, schema, database size, and integrity checks |
| docs(status): record current-head Windows run 47 (`a5ea6bb`) | Refresh P0 desktop, API, and recovery evidence for the restore-report implementation |
| feat(story): guide world creation with a focused wizard (`a3674a6`) | Split world authoring into setting, places/opening, and optional rules/review steps with pre-save validation |
| fix(continuity): respect revision cutoffs in RPG proposals (`41e2c3e`) | Hide proposals created after an as-of revision and restore pending status before later review decisions |
| docs(status): record current-head Windows run 50 (`40c5cc9`) | Record the completed current implementation checks and installer artifact; keep clean-machine and focused feature acceptance open |
| docs(status): clarify implementation validation head | Tie run 50 claims to the latest implementation commit while distinguishing the later documentation-only branch head |

### RPG authoring and deterministic play

- Added world-pinned point-buy character creation. Each world version can define baselines, bounds, costs, budgets, below-baseline refunds, and whether points may remain unspent. The API preflights the allocation and the gateway validates it again before creating the isolated adventure sheet.
- Added explicit exceptional-ability definitions and branch-local activation state. The world version records effects, declared costs/cooldowns, capabilities, limitations, and unresolved aspects. Undeclared costs or restrictions are not invented.
- Added world-pinned d20, custom dice, narrative-only, and hybrid mechanics, with difficulty and encounter definitions, skill ranks, and manual/automatic/hybrid experience. The API generates dice and gateway code validates and records the deterministic result with a rule snapshot.
- Added reviewable setup and play surfaces for mechanics, abilities, experience, and starting attributes. Added a bounded, validated local world cover image with alt text.
- Added an optional local-Ollama World Architect. Its strict draft schema checks bounded text, unique location names, and a matching starting location; the user previews and applies the draft to editable fields, then explicitly saves through the world command. It creates no canonical write and never calls an external provider.
- Added an explicit cancel action for local World Architect generation. Aborting stops the browser request, reports that no world data was saved, and leaves manual world creation available.
- Added an optional, structured opening-scene seed to immutable world versions. Setup requires situation and hook together, displays the exact seed during final review, and the provider context includes it only for the first generated response; public world packages preserve the seed.
- Validate portable world location names and starting-place references with the same rules used by the world editor, and normalize opening-scene text before imported versions become canonical. Legacy v1 packages and empty-map formats remain supported.

### Continuity and providers

- Editing or hiding a turn now supersedes later turns from canonical transcript order. Historical RPG reconstruction covers supported character-sheet, accepted NPC-profile, and map-location changes while preserving direct player edits.
- Historical RPG snapshots exclude proposals created after the requested revision and show accepted/rejected proposals as pending when their review happened later. Focused as-of proposal acceptance remains open.
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
- Put **New adventure** beside the library heading and make it open the first setup step. Keep the most recent adventure in its dedicated resume card instead of listing it twice; show the first eight other matches and place the remainder behind a count-labelled disclosure. Search and result counts continue to cover the full library.
- Renamed the setup progress step to **Build**, aligned its heading and action with attribute allocation, clarified that setup sends no model request, and explain whether remaining points can be left unspent. The point-budget status is announced as it changes.
- Split world creation into **Setting**, **Places & opening**, and **Rules & review** steps. The first path keeps the required premise and optional local World Architect together; map/opening fields are directly editable on the next step; custom trackers, mechanics, attributes, and abilities remain behind an explicit disclosure on the final step. A review summary precedes the existing canonical save, and invalid location references or incomplete opening scenes block progression.

### Backup and recovery

- After a successful restore, report the backup timestamp, schema version, database size, restored workspace count, and integrity/foreign-key verification result. If the follow-up workspace refresh fails, say the restore already succeeded and direct the user to Refresh instead of repeating the destructive restore. Browser acceptance of these messages and the separate-device restore drill remain open.

### Tests and validation in this branch

- Added focused tests for character creation, exceptional abilities, configurable mechanics, and story library lifecycle; expanded package, API, provider, continuity, migration, and backup/restore coverage.
- Corrected the world-cover test to cover all three intended validations: the canonical world update, the stored package before export, and the redacted public package.
- TypeScript passed locally, and the current Windows workflow runs the complete frontend build. The local Vite bundle attempt was blocked by sandbox `spawn EPERM`; the Windows Actions build is the production-bundle evidence.
- The Story Studio browser check verified the header action opens setup, a 32-adventure library initially shows eight additional cards, expansion exposes the rest, and search still returns the correct one-of-32 result. At 700 × 900, compact navigation and library controls remained usable.
- GitHub Actions Windows run 40 at schema-v17 commit `851a1b1` passed all 190 core/API tests in 12.610 seconds, story-export privacy, and frontend type/build checks. The bundled API passed health, token authentication, isolated command persistence, Unicode, and audit smoke checks. MSI and NSIS installers (26.57 MiB and 25.46 MiB) were uploaded as artifact `lke-windows-installers` (ID `12917692947`, 54,329,028 bytes; expires 2027-01-27).
- GitHub Actions Windows run 41 at UI commit `80095ba` passed all 190 core/API tests in 12.454 seconds, story-export privacy, frontend type/build, bundled API smoke, MSI/NSIS build, and artifact upload. Its `lke-windows-installers` artifact (ID `12920110955`, 54,331,297 bytes) expires on 2027-01-27. Run 40 at `851a1b1` provides the published per-installer sizes: MSI 26.57 MiB and NSIS 25.46 MiB.
- GitHub Actions Windows run 43 at implementation commit `98bdbed` passed the full core/authenticated API suite, story-export privacy, frontend type/build, bundled API smoke, MSI/NSIS build, and artifact upload. Its `lke-windows-installers` artifact (ID `12921408725`, 54,343,530 bytes; SHA-256 `5d65ef222a3cdf15b99e392998fccd7fba0ec1cc30d286cae5d683d69d0a0e60`) expires on 2027-01-27. The full suite passed, but the new World Architect and opening-scene paths still need focused browser and live-local-model acceptance; packaging does not prove clean-machine GUI lifecycle.
- GitHub Actions Windows run 49 at world-authoring commit `a3674a6` passed the full core/authenticated API suite, story-export privacy, frontend type/build, bundled-sidecar smoke, MSI/NSIS build, and artifact upload. Run 50 at the latest implementation commit `41e2c3e` also passed every check and uploaded `lke-windows-installers` (ID `12958178054`, 54,347,577 bytes; SHA-256 `cb76b555828e9dcd82aebe412eb8844fd7464d1491e4ed45fd68b34c7da31fa4`), expiring 2027-01-28. These CI runs establish source checks and packaging only: focused browser acceptance for the World Architect, opening scene, cancellation, restore report, wizard, and historical proposal cutoffs remains open, as does clean-machine GUI lifecycle.
- Earlier Windows run 47 at `b2a4f16` passed the same workflow and uploaded artifact `12955889570` (54,341,896 bytes; SHA-256 `c3cac5e50d29ec6aaf1c7e3b9e492b4782f8bd4661b55aab60b87d53265923c4`). It is retained as historical evidence; the latest implementation evidence is run 50.
- Full lifecycle browser acceptance, hostile-file UI checks, live provider behavior, clean-machine installation and launch, and separate-device recovery remain open. See docs/PROJECT_STATUS.md and docs/ACCEPTANCE_MATRIX.md.

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
