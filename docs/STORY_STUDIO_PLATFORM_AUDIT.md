# Story Studio platform audit and completion priorities

Audit date: 2026-10-29. Implementation is authorized and in progress. This document distinguishes source inspection from verified behavior; it is not a release declaration.

## Product outcome

Provide a local-first RPG studio where a player can choose or create a reviewed world, build a protagonist, and play or resume an isolated adventure with durable, character-aware continuity. Keep everyday play focused on the transcript, composer and essential state. Put world construction, model configuration, memory inspection and asset management in contextual panels.

## Evidence

- The current repository was inspected at schema v13, including the gateway, retrieval, API, Story UI, tests and acceptance matrix.
- [MNO RPG Engine](https://perchance.org/mnoengine) was observed on its landing page on 2026-10-23. Its user-supplied changelog covers 2026-09-12 through 2026-10-23. The latest Computer Use session was stopped with Escape before deeper interactive flows were reopened. Changelog entries are product-owner reports; gameplay, generation quality and round-trip behavior were not independently tested.
- [MemGPT](https://arxiv.org/abs/2310.08560) motivates tiered context; [Generative Agents](https://arxiv.org/abs/2304.03442) describes retrieval using relevance, recency and importance; [LongMemEval](https://arxiv.org/abs/2410.10813) identifies extraction, multi-session and temporal reasoning, knowledge updates and abstention as separate evaluation abilities. These ideas require local measurement, not an assumption that any one method solves continuity.
- Detailed prior observations and source boundaries are in [the competitor research log](agents/COMPETITOR_RESEARCH_LOG.md). Current verification and release gates belong in [the acceptance matrix](ACCEPTANCE_MATRIX.md).

## Must have

| Capability | Current source evidence | Work required for completion |
|---|---|---|
| World and adventure lifecycle | Versioned worlds, pinned adventure snapshots, creation and resume exist. | Complete blank/template/AI-draft paths, final hero review, reliable duplication, searchable libraries and end-to-end isolation/reopen tests. Preserve unbound legacy stories. |
| Portable projects and recovery | Full database backup/restore exists. The `lke.world.v1` package exports world versions, previews the source and collision, and imports a duplicate through the gateway. | Verify the world flow in the API and browser, and implement explicit replacement if required. Adventure packages still need preview, bounded validation, remapping, histories and assets, without provider secrets; test hostile packages and restore elsewhere. |
| Play and turn lifecycle | Transcript, composer, edit, retry, hide and stop controls exist. Recent history is filtered by story order and retry episode recall uses the preceding transcript. | Ensure retry/edit invalidates or reconstructs dependent state and summaries; prevent current sheet, NPC state, checks or equal-order records from leaking into earlier scenes. Prove cancellation, failures, idempotency and recovery across API and browser. |
| Rules and reviewed state | Gateway records deterministic d20 arithmetic and reviewable RPG changes. | Complete selective/editable review for quests, relationships, trackers, locations and NPCs, with stale-revision and atomic transaction coverage. The model never changes check arithmetic. |
| Long-term continuity | Reviewed, scoped memory records and source-linked lexical recall over older turns exist. The raw transcript is retained. | Add automatic event-memory proposals with source spans, correction/supersession, summary coverage and invalidation; maintain major and minor details. Filter workspace, branch, actor, review, visibility and time before ranking in every path. Test secrets, conflicting accounts, future facts, edits, branches and Persian recall under fixed budgets. |
| NPC identity and knowledge | Profiles, aliases and opt-in reviewed simulation are present. | Complete explicit name matching/linking/new-character choices without rewriting transcript text; give NPCs actor-scoped knowledge, memories, voice, goals, relationships and trackers. Ensure one NPC cannot acquire another's secret. |
| Provider choice and privacy | Code routes story generation and memory answers through Ollama, OpenAI, Claude, Codex app-server and Hugging Face hosted/local adapters; the play UI exposes provider and model selection. | Verify each protocol against a real configured provider, make configuration understandable, expose destination and cost implications, and preserve cancellation. No provider writes canon. Credentials stay out of story packages and logs. Local inference remains usable without a paid provider. |
| Quality and release | Focused unit tests and a frontend build are useful source evidence. | Complete authenticated API, real browser, Persian RTL/mixed-script, live local model, backup/restore, Windows packaging and clean-machine acceptance. A unit suite alone is not release proof. |

## Should have

- World editor sections for basics, lorebook, author notes, cast, stats, player and NPC trackers, opening scenes and art. Offer presets, AI drafts, reorder and duplicate-name warnings, with review before use. A compact basic path should remain available.
- Story controls inspired by MNO: optional tracker-change visibility and context meter; clear edit/retry/stop controls; searchable and grouped adventures; safe choice buttons; and preserved previous artwork when regeneration fails.
- Optional map with reviewed points of interest, meaningful scale, a clear distinction between suggestions and canon, and player-selected travel. Add quest/objective status and bounded experience rules before arbitrary formulas.
- Optional NPC life simulation remains off by default, runs at most two NPCs every five completed turns, and produces reviewable goals, whereabouts, activities and memories rather than silent canonical writes.
- Character reference sheets, scene images, provenance, selective regeneration, editable page/scene cards and local reader/print export. Uploaded artwork must remain usable without an image service.
- Relevance ranking and context inspection should show included and excluded source IDs, scope, reason, revision and approximate budget. Compare lexical/entity retrieval and any local embeddings on a fixed bilingual corpus before changing defaults.

## Could have

Narration, inpainting/outpainting, animation, cover composition and advanced provider sampling can follow validated text and image workflows. Public catalogs, accounts, community chat and arbitrary rule scripting are deferred under the approved local-only scope. MNO's community features and creator identity are reference material, not requirements for the initial single-user release.

## MNO options that informed this review

The changelog records AI world crafting and lore splitting; world author notes, tag picks, preset/generated stats and trackers, NPC tracker definitions, visibility and inclusion controls; hero randomization, avatar history and a final review; editable situation and threads, manual-memory switches and tiered recall; explicit NPC alias linking and name handling; map travel and points of interest; quest completion; provider sampling and output limits; scene image direction, aspect ratio, style and references; adventure duplication and import collision choices; and backup merge/replace. It also reports experimental matching, context limits, memory roll-up fixes, tracker leakage fixes and earlier name-matching errors. These are useful design leads, not independently established quality claims.

## Completion gates

Do not mark the upgrade complete until each must-have row has a demonstrated workflow and failure-path evidence. Record exact fixture versions, provider/model, prompt and source revision, hardware, latency, context size and retrieval metrics. Separate deterministic exclusion tests from live-model prose evaluation. The current historical-state reconstruction, package import/export, automatic memory extraction, live provider verification and Windows installation gates remain open.
