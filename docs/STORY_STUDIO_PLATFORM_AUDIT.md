# Story Studio platform audit and completion priorities

Audit date: 2026-10-29. Implementation is authorized and in progress. This document distinguishes source inspection from verified behavior; it is not a release declaration.

## Product outcome

Provide a local-first RPG studio where a player can choose or create a reviewed world, build a protagonist, and play or resume an isolated adventure with durable, character-aware continuity. Keep everyday play focused on the transcript, composer and essential state. Put world construction, model configuration, memory inspection and asset management in contextual panels.

## Evidence

- The current repository was inspected at schema v14, including the gateway, retrieval, API, Story UI, tests and acceptance matrix.
- [MNO RPG Engine](https://perchance.org/mnoengine) was inspected through a live landing page on 2026-10-23, followed by the user-supplied saved HTML/static assets, screenshots, changelog and paired `.mno-world` / `.mno-adv` exports on 2026-10-29. Static scripts were not executed and the screenshots show particular rendered states only. The supplied world was imported through the gateway and its adventure was converted, previewed and imported through authenticated ASGI into an in-memory database; MNO gameplay and quality were not independently tested.
- The saved pages show distinct Worlds and Adventures navigation, a central transcript/composer, contextual Story/Session/Memories and Hero/Map/NPCs/Gallery panels, a context-size indicator, and library search/filter/sort. The supplied map/NPC screenshots show coordinate POIs and profile/memory/life views. Exact source and count evidence is in the [competitor research log](agents/COMPETITOR_RESEARCH_LOG.md).
- [MemGPT](https://arxiv.org/abs/2310.08560) motivates tiered context; [Generative Agents](https://arxiv.org/abs/2304.03442) describes retrieval using relevance, recency and importance; [LongMemEval](https://arxiv.org/abs/2410.10813) identifies extraction, multi-session and temporal reasoning, knowledge updates and abstention as separate evaluation abilities. These ideas require local measurement, not an assumption that any one method solves continuity.
- Detailed prior observations and source boundaries are in [the competitor research log](agents/COMPETITOR_RESEARCH_LOG.md). Current verification and release gates belong in [the acceptance matrix](ACCEPTANCE_MATRIX.md).

## Must have

| Capability | Current source evidence | Work required for completion |
|---|---|---|
| World and adventure lifecycle | Versioned worlds, pinned isolated adventure snapshots, resume-first cards, collapsed setup, a compact searchable/sortable world list, filtered adventure cards and an inline pre-start summary exist. | Verify the complete flow in a browser, including isolation, reopen, duplicate and partial-setup recovery. Preserve unbound legacy stories. |
| Portable projects and recovery | `.lke-world` / `.lke-adventure` and MNO `.mno-world` v1 / `.mno-adv` v2 previews/imports exist; adventure import retains turns, private source archive, assets, NPCs, map and review records without context manifests. Full backup/restore exists. | Complete real-browser import/export and hostile-package checks, plus separate-device restore. File-backed migrations from legacy schemas through v14 now pass. Keep imports duplicate-first and provider credentials excluded. |
| Play and turn lifecycle | Transcript, composer, edit, retry, hide and stop controls exist. Recent history is filtered by story order, retry recall uses the preceding transcript, and the gateway supersedes later turns automatically when a turn is edited or hidden. Retries now use fact values and structured RPG state captured by the selected turn's saved context manifest, subject to current permissions. | Rebuild canonical RPG state and summaries after edits; prevent stale accepted downstream changes from leaking into later continuation after a historical edit. Prove cancellation, failures, idempotency and recovery across API and browser. |
| Rules and reviewed state | Gateway records deterministic d20 arithmetic and reviewable tracker/location/NPC/event-memory changes. | Extend selective review to quest/relationship outcomes and prove stale-revision and provider-failure behavior in the browser. The model never changes check arithmetic. |
| Long-term continuity | Reviewed, scoped memory records, source-linked lexical recall, and automatic bounded event excerpt proposals on committed or retried scenes exist. The raw transcript is retained. | Add semantic event extraction with source spans, explicit correction/supersession links, summary coverage and invalidation; maintain major and minor details. Filter workspace, branch, actor, review, visibility and time before ranking in every path. Test secrets, conflicting accounts, future facts, edits, branches and Persian recall under fixed budgets. |
| NPC identity and knowledge | Profiles, aliases, private data, opt-in simulation, and atomic world-cast NPC creation are present. MNO secrets/life/trackers are separated from public profile context. | Complete actor-scoped per-NPC knowledge, explicit matching/linking without rewriting transcript text, and reviewable memory/relationship changes. Verify voice and privacy under multiple NPCs. |
| Provider choice and privacy | Code routes story generation and memory answers through Ollama, OpenAI, Claude, Codex app-server and Hugging Face hosted/local adapters; the play UI exposes provider and model selection. | Verify each protocol against a real configured provider, make configuration understandable, expose destination and cost implications, and preserve cancellation. No provider writes canon. Credentials stay out of story packages and logs. Local inference remains usable without a paid provider. |
| Quality and release | Focused unit tests and a frontend build are useful source evidence. | Complete authenticated API, real browser, Persian RTL/mixed-script, live local model, backup/restore, Windows packaging and clean-machine acceptance. A unit suite alone is not release proof. |

## Should have

- World editor sections for basics, lorebook, author notes, cast, stats, player and NPC trackers, opening scenes and art. Imported MNO world cast can be selected per adventure; a complete authoring editor, presets, AI drafts, ordering and duplicate-name warnings remain future work. Keep the basic path short.
- MNO-inspired play controls: context-size/status visibility, clear edit/retry/stop, searchable world/adventure lists with recent or A–Z sorting, safe choice buttons and preservation of prior artwork when regeneration fails.
- Optional map with coordinate-backed imported points, explicit location list and player-selected travel exists. Improve authored-map editing and scale semantics; never invent distances from unknown coordinate units. Add quest/objective status and bounded experience rules before arbitrary formulas.
- Optional NPC life simulation remains off by default, runs at most two NPCs every five completed turns, and produces reviewable goals, whereabouts, activities and memories rather than silent canonical writes.
- Character reference sheets, scene images, provenance, selective regeneration, editable page/scene cards and local reader/print export. Uploaded artwork must remain usable without an image service.
- Relevance ranking and context inspection should show included and excluded source IDs, scope, reason, revision and approximate budget. Compare lexical/entity retrieval and any local embeddings on a fixed bilingual corpus before changing defaults.

## Could have

Narration, inpainting/outpainting, animation, cover composition and advanced provider sampling can follow validated text and image workflows. Public catalogs, accounts, community chat and arbitrary rule scripting are deferred under the approved local-only scope. MNO's community features and creator identity are reference material, not requirements for the initial single-user release.

## MNO options that informed this review

The live and saved MNO UI shows world/adventure libraries, search/filter/sort, separate setup and session workflows, map travel, portrait/profile/memory/life panels, a gallery, model/context controls, and local backup/import affordances. Its changelog additionally reports AI world crafting and lore splitting; author notes, tags, preset/generated stats and trackers, NPC tracker definitions, visibility/inclusion controls; hero randomization and a final review; situation/thread editing and tiered recall; alias linking; quest completion; provider sampling and output limits; image direction/style/references; duplication/collision choices; and backup merge/replace. It also records experimental matching, context limits, memory roll-up fixes, tracker leakage fixes and prior name-matching errors. These are design leads and changelog claims, not independent quality findings.

## Completion gates

Do not mark the upgrade complete until each must-have row has a demonstrated workflow and failure-path evidence. Record exact fixture versions, provider/model, prompt and source revision, hardware, latency, context size and retrieval metrics. Separate deterministic exclusion tests from live-model prose evaluation. MNO and portable package adapters now have focused tests and local validation against the supplied exports. Canonical state reconstruction after an old turn edit, semantic event/correction extraction, real-browser flow, live provider verification, Windows installation, and separate-device recovery remain open.
