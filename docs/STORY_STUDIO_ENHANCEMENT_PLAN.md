# Story Studio enhancement plan

Date: 2026-10-23. Status: proposed; documentation only. No implementation authorization is implied.

## Recommendation

Build a coherent authoring and play experience on the existing LKE core: improve continuity first, then add reusable worlds and guided sessions, then illustrated publishing. Do not replace canonical storage with a memory vendor or make video generation a release dependency. Finish existing integrity and desktop acceptance gates alongside this work.

## Evidence and limits

Public pages and repository source were inspected on the date above. Product descriptions establish advertised capabilities, not tested quality. No accounts, paid generations, uploads, or competitor performance tests were used. Local findings are source inspection, not a runtime acceptance result.

Sources:

- G: [Gemini Storybook](https://gemini.google/overview/storybook/), including its editing and sharing FAQ.
- S: [Story Studio AI](https://story-studio.ai/), especially Story Chat, Creator, Illustrator, and Playground. Its consistency claims have not been benchmarked.
- M: [Supermemory](https://supermemory.ai/) and [official documentation index](https://supermemory.ai/docs/llms.txt). The index identifies graph memory, namespaces, profiles, semantic search, inferred-memory review, connectors, and evaluation documentation. Individual Markdown detail pages failed extraction; implementation semantics remain unverified.
- P: [MNO RPG Engine](https://perchance.org/mnoengine). Browser accessibility inspection successfully reached the embedded engine. Observed: Worlds/Adventures/Explore navigation, create-world and adventure actions, world-file import, library search/filter/sort, Data & Backup, and local-storage notices. The welcome panel advertises skill checks, stats, trackers, a map, and NPCs; actual gameplay behavior was not exercised.

## Current project baseline

Read PRODUCT.md, ARCHITECTURE.md, docs/contracts/NARRATIVE_RULES.md, guides/instructions.md, backend/lke/retrieval/context.py, and relevant frontend/src/App.tsx and storyExport.ts paths. Existing capabilities include revisioned conversations, character-memory questions with citations, JSON story/context export, actor-awareness and future-fact filtering, branches, review, knowledge graphs, journal records, and backup/restore. Do not count these as missing features.

ContextCompiler currently walks accepted claims in narrative order, checks awareness, and applies an approximate character-based token budget. It has no query relevance ranking in that compilation path. Its manifest already records exclusion reasons: extend this asset rather than inventing a second memory store. Narrative rules describe richer scene and character frames than the implementation currently delivers. Architecture documentation explicitly marks scene state deltas, media/document ingestion, and live-model validation as incomplete.

## Comparative opportunities

| Reference and positive feature | Current gap or partial foundation | Practical adaptation | Priority |
|---|---|---|---|
| G: complete illustrated book with narration | JSON export exists; paginated illustrated reading/publishing is not evidenced | Chapter/page outline, reader, print export, optional narration | P2 |
| G: personal files/photos as inspiration | Text import exists; media and PDF ingestion incomplete | Preserved attachments and extracted evidence, with fiction clearly distinguished from personal records | P2 |
| G: language support and conversational revision | Persian guidance exists; multilingual publishing quality unverified | Persian-first RTL acceptance, page-level revisions and regeneration | P1/P2 |
| S: consistent characters and conversational creation | Actor facts exist; reusable voice/appearance profiles and consistency evaluation incomplete | Versioned character bible and bounded voice examples | P1 |
| S: illustrated novel from imported text; consistent art | No integrated scene-to-asset production flow evidenced | Approved manuscript to storyboard, reference sheets, selective image revision | P2 |
| S: inpainting, outpainting, animation and voice | Media pipeline absent from inspected core | Optional adapter roadmap after asset provenance and cost controls | P3 |
| M: interconnected temporal memory and semantic recall | Canonical claims and awareness exist; context selection is chronological | Scope-safe relevance retrieval, temporal supersession and context inspection | P1 |
| M: profiles and inferred-memory review | Review already exists; author preference profile and reviewable synthesis incomplete | Separate author preferences, character knowledge, episodic summaries and tentative inferences | P1 |
| M: interoperable memory and measurable recall | Portable context exists; retrieval quality evaluation missing | Provider-neutral context contract and local benchmark | P0/P1 |
| P: reusable local world library and separate adventures | Workspaces/branches exist; reusable world-template workflow not evidenced | Versioned world packages, independent sessions, import preview | P1 |
| P: search/filter/sort and discoverable backup | Core data/recovery exists; world-library experience incomplete | Library cards, tags, resume and backup status | P1 |
| P: advertised stats/checks/trackers/map/NPCs | Rules and graph exist; game-session mechanics incomplete | Optional bounded mechanics with reviewed state changes | P2 discovery |

## Work packages and acceptance

### E0 — Establish the quality baseline (P0, small)

Create a documented evaluation set before tuning generation: a secret known to only one NPC, future knowledge, a corrected belief, two conflicting accounts, a branch divergence, a long Persian conversation, and an empty-memory question. Record model, prompt version, source revision, latency and token estimates. Acceptance: every case has expected permitted facts, forbidden facts, and an inspectable context manifest. Zero forbidden-fact inclusions in deterministic retrieval fixtures is a release gate; live-model prose leakage is measured separately and cannot be claimed solved by retrieval tests alone.

### E1 — Memory selection and lifecycle (P1, medium/large)

Apply workspace, branch, time, review and actor permissions before ranking. Combine lexical relevance, optionally local embeddings, scene relevance, recency and user pins; never let relevance override access. Reserve context for hard rules and current scene before summaries. Add an inspector showing included/excluded records, reason, source, revision, score and budget. Summaries are rebuildable projections with source spans, coverage and invalidation rules. Separate historical record retention from retrieval suppression; corrections supersede claims without erasing provenance. A stale summary must be rebuilt or omitted.

Acceptance: relevant late records survive a tight budget; corrections invalidate dependent summaries; secrets remain inaccessible through summaries, caches and semantic search; switching model preserves the same authorized canon. Compare retrieval precision/recall, contradiction rate, context size and latency against E0. Numeric performance targets follow measured local hardware baselines, not vendor marketing.

### E2 — Character bible and scene continuity (P1, large)

Add proposed contracts for identity, motivations, relationship stance, speech register, appearance references, bounded voice examples and current scene state. Keep stable traits, changing beliefs and author preferences separate. Persian requirements include natural dialogue, moderate pacing, RTL/Vazirmatn, and user control of protagonist speech and consequential actions. Generated events and state changes enter a review queue with source turn, before/after values, confidence and conflicts. Unknown preconditions remain unknown.

Acceptance: reject a delta without changing canon; accept it through one auditable command transaction; stale-revision acceptance fails safely; an NPC cannot acquire a secret from another scene; a style example cannot override world rules or user agency. Judge voice and pacing with a human rubric and live-model samples, not keyword checks.

### E3 — World library and guided session setup (P1, medium)

Offer create-world, resume-session, and start-from-template paths. A world template contains reviewed lore, character profiles, optional rules and opening-scene suggestions. An adventure references an immutable template version and evolves independently. Preview imports, schema/version compatibility, provenance, collisions and untrusted instructions before committing. Allow tags/search/sort and explicit session separation. Do not treat a branch as a replacement for a separately isolated workspace.

Acceptance: two adventures from one template cannot mutate each other; export/import retains IDs or reports an explicit remap; unsupported versions and malicious paths are rejected; reopen and full backup/restore preserve both sessions. A new user can reach a first scene without understanding the knowledge graph.

### E4 — Storyboard and publishing (P2, large)

Create an approved outline, editable scene/page cards, a reading view and local print/export. Images attach to page and character revision, with prompt, provider/model, reference asset, generation settings, license notes and cost metadata. Support uploaded art before requiring image generation. Regenerate one asset without rewriting other pages or canon. Narration is optional, with a language capability check, transcript and playback controls. Never promise Persian voice support before testing an actual adapter.

Acceptance: mixed Persian/English text and punctuation render correctly in reader and exported pages; a single-page edit preserves other assets; secrets/prompts/context are excluded from public artifacts by default; export preview lists exactly what leaves the workspace. Cancellation and provider failure leave the manuscript intact. Public hosting is separate, explicitly chosen scope.

### E5 — Optional mechanics and richer media (P3, large/uncertain)

First investigate MNO gameplay with a disposable session: inspect character creation, checks, tracker persistence, save/load, map meaning and failure recovery. Only then specify comparable mechanics. If adopted, record ruleset version, roll inputs/results, state deltas and review policy; maps must distinguish illustrative geography from canonical locations. Video, inpainting and outpainting follow E4 and require per-job budgets, cancellation, retry limits and asset lineage. Defer public communities and unrestricted autonomous NPC simulation.

## Sequence, dependencies and decision gates

E0 → E1 and E2 → E3 → E4 → E5. E3 discovery can happen earlier; full template serialization depends on stable E2 contracts. Relative effort labels are planning estimates, not delivery dates. Release hardening from ACCEPTANCE_MATRIX.md remains a parallel prerequisite, especially live Ollama, desktop packaging, browser workflows and restore drills.

Before each implementation slice, write the smallest end-to-end contract, migration/rollback plan, acceptance fixture, privacy boundary and affected modules. Likely owners: retrieval/context for E1; core commands plus narrative/provider contracts for E2; source/backup and UI for E3; new asset adapter and publishing UI for E4. These are suggested boundaries, not code instructions or approved schemas.

Decide after evidence: local embedding model and multilingual quality; profile versioning; scene-delta review granularity; world-package format; image/TTS adapter availability and licenses. Do not install Supermemory merely because its features are attractive. Evaluate it only as an optional rebuildable adapter against local retrieval, scoped consent, deletion behavior, offline operation, license, packaging and measured benefit. Canonical SQLite and the command gateway remain authoritative.

## Risks and rejected shortcuts

- Automatic memory inference can turn fiction or speculation into apparent truth: preserve evidence and require review for canon.
- Compression can leak secrets or flatten contradictory beliefs: compile per actor and retain disputed provenance.
- Old facts can crowd out current context: evaluate relevance under fixed budgets.
- Consistent art is an aspiration until measured: use approved references and per-character review.
- Browser-local competitor storage is convenient but not a substitute for recoverable desktop backups.
- Whole-book regeneration creates unwanted drift: prefer selective revisions, an improvement over G's documented whole-story regeneration flow.
- Avoid copying external branding, content or proprietary internals. Adopt workflow ideas and independently designed contracts.
- No social publishing, connectors, paid services or broader cloud transfer are authorized by this plan.

## Completion record for this planning step

Delivered comparative review, source boundaries, prioritized packages, acceptance criteria and agent workflow documents. No application code, schemas, dependencies or runtime configuration changed. Competitor quality and current local runtime behavior remain untested. MNO gameplay and Supermemory detail semantics remain focused follow-up research tasks rather than invented findings.
