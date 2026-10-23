# Story Studio enhancement plan

Date: 2026-10-23. Status: proposed; documentation only. No implementation authorization is implied.

## Recommendation

Build a coherent authoring and play experience on the existing LKE core: improve continuity first, then add reusable worlds and guided sessions, then illustrated publishing. Do not replace canonical storage with a memory vendor or make video generation a release dependency. Finish existing integrity and desktop acceptance gates alongside this work.

## Evidence and limits

Public pages, the MNO RPG Engine browser interface and repository source were inspected on the date above. Product descriptions establish advertised capabilities, not tested quality. No accounts, paid generations, uploads, adventure creation, or competitor performance tests were used. Local findings are source inspection, not a runtime acceptance result. The MNO review opened library, adventure setup, provider, identity, and backup screens but did not start a game or change settings.

Sources:

- G: [Gemini Storybook](https://gemini.google/overview/storybook/). The official page advertises personalized illustrated ten-page books from prompts, files and photos, reading/listening/printing/sharing, and creation in 45+ languages. Its FAQ says page text cannot be edited directly; conversational refinement regenerates the story and all images. Narration has narrower language availability than story generation.
- S: [Story Studio AI](https://story-studio.ai/), especially Story Chat, Creator, Illustrator, and Playground. The landing page advertises conversational character chat, branching interactive stories, PDF/TXT/pasted manuscript illustration, consistent art, image editing/extension, and video up to two minutes. These are vendor claims; the experience, character consistency, quality, credits/cost, rights, and failure behavior were not tested.
- M: [Supermemory product](https://supermemory.ai/product/), [official docs index](https://supermemory.ai/docs/llms.txt), [API reference](https://api.supermemory.ai/reference), and [API changelog](https://supermemory.ai/changelog/api/). The current product description distinguishes raw documents from extracted atomic memories; models updates, extensions, derivations, profiles, time-aware fact/preferences/episodes, semantic/hybrid retrieval, source traversal, and review of low-confidence inferences. The API reference shows namespace-scoped operations, and docs describe a local runtime using local embeddings and configurable local inference. The product/changelog describe behavior; it has not been installed or tested here. Its default scope is not sufficient authorization by itself, and its explicit forget behavior is documented as excluding memories from search while retaining records.
- P: [MNO RPG Engine](https://perchance.org/mnoengine). Browser inspection observed separate Worlds and Adventures libraries, a new-adventure flow that binds one adventure to a selected world, `.mno-world` and `.mno-adv` import entry points, library search/filter/sort, community-world tags/likes/download counts, an NSFW-off default, AI world-crafting description, identity recovery, and a backup screen with merge/replace restore. Its settings expose Perchance AI, OpenAI, DeepSeek, OpenRouter, and local Ollama for text; image settings expose Perchance AI, OpenAI, and OpenRouter plus a prompt-guidance slider. The UI warns the default Perchance text model has a small context window and browser storage can be cleared. The welcome panel advertises checks, stats, trackers, map, and NPCs. Gameplay mechanics and generated outputs were not exercised. Further detail and evidence limits are in [the research log](agents/COMPETITOR_RESEARCH_LOG.md).

## Current project baseline

Read PRODUCT.md, ARCHITECTURE.md, docs/contracts/NARRATIVE_RULES.md, guides/instructions.md, backend/lke/retrieval/context.py, and relevant frontend/src/App.tsx and storyExport.ts paths. Existing capabilities include revisioned conversations, character-memory questions with citations, JSON story/context export, actor-awareness and future-fact filtering, branches, review, knowledge graphs, journal records, and backup/restore. Do not count these as missing features.

ContextCompiler currently walks accepted claims in narrative order, checks awareness, and applies an approximate character-based token budget. It has no query relevance ranking in that compilation path. Its manifest already records exclusion reasons: extend this asset rather than inventing a second memory store. Narrative rules describe richer scene and character frames than the implementation currently delivers. Architecture documentation explicitly marks scene state deltas, media/document ingestion, and live-model validation as incomplete.

## Comparative opportunities

| Reference and positive feature | Current gap or partial foundation | Practical adaptation | Priority |
|---|---|---|---|
| G: complete illustrated book with narration | JSON export exists; paginated illustrated reading/publishing is not evidenced | Chapter/page outline, editable page text, reader, print export, optional narration with per-language capability checks | P2 |
| G: personal files/photos as inspiration | Text import exists; media and PDF ingestion incomplete | Preserved attachments and extracted evidence, with fiction clearly distinguished from personal records | P2 |
| G: language support and conversational revision | Persian guidance exists; multilingual publishing quality unverified | Persian-first RTL acceptance, page-level revisions and regeneration | P1/P2 |
| S: consistent characters and conversational creation | Actor facts exist; reusable voice/appearance profiles and consistency evaluation incomplete | Versioned character bible and bounded voice examples | P1 |
| S: illustrated novel from imported text; consistent art | No integrated scene-to-asset production flow evidenced | Approved manuscript to storyboard, reference sheets, selective image revision | P2 |
| S: inpainting, outpainting, animation and voice | Media pipeline absent from inspected core | Optional adapter roadmap after asset provenance and cost controls | P3 |
| M: temporal memory graph and hybrid recall | Canonical claims, revisions and actor awareness exist; context selection remains chronological and there is no derived fact lifecycle | Explore relevance ranking and typed temporal summaries as rebuildable projections; inspect source and supersession links | P1 |
| M: profiles and reviewable inference | Human review exists; author preference profiles and derived narrative summaries are not separate concepts | Keep author preferences, character knowledge, episodic scene summaries and tentative inference distinct; require evidence and review before canon | P1 |
| M: local runtime and portable API | Ollama and provider-neutral context exist; no embedded graph-memory engine | Evaluate local runtime only against existing retrieval on a fixed corpus; preserve SQLite as authority and treat external/local engine output as a proposal/projection | P1 research gate |
| P: reusable local world library and separate adventures | Workspaces/branches exist; no world-template and independent-session onboarding flow is evidenced | Versioned world packages and separate adventures; make provenance, migration and import preview visible | P1 |
| P: community discovery and creator identity | No public account or creator marketplace is in the single-user product baseline | Defer public publishing/community; reuse local tags, search and explicit world ownership only where useful | Deferred |
| P: local provider choice and image controls | Local Ollama exists for text; no image generation adapter exists | Retain model isolation, show model capability and context limits; make visual providers optional and expose cost/availability before jobs | P2 |
| P: advertised stats/checks/trackers/map/NPCs | Deterministic rules and graph exist; game-session mechanics incomplete | Explore optional deterministic checks and visible trackers; save changes as reviewed, revisioned proposals | P2 discovery |

## Work packages and acceptance

### E0 — Establish the quality baseline (P0, small)

Create a documented golden evaluation set before tuning retrieval: a secret known to only one NPC, future knowledge, a corrected belief, two conflicting accounts, a branch divergence, a long Persian conversation, and an empty-memory question. The repository already has relevant unit/API/browser acceptance evidence, but no fixed bilingual retrieval corpus or numerical baseline; preserve and extend that evidence rather than duplicate it. Record model, prompt version, source revision, latency and token estimates. Acceptance: every case has expected permitted facts, forbidden facts, and an inspectable context manifest. Zero forbidden-fact inclusions in deterministic retrieval fixtures is a release gate; live-model prose leakage is measured separately and cannot be claimed solved by retrieval tests alone.

### E1 — Memory selection and lifecycle (P1, medium/large)

Apply workspace, branch, time, review and actor permissions before ranking. Combine lexical relevance, optionally local embeddings, scene relevance, recency and user pins; never let relevance override access. Reserve context for hard rules and current scene before summaries. Add an inspector showing included/excluded records, reason, source, revision, score and budget. Summaries are rebuildable projections with source spans, coverage and invalidation rules. Separate historical record retention from retrieval suppression; corrections supersede claims without erasing provenance. A stale summary must be rebuilt or omitted.

Acceptance: relevant late records survive a tight budget; corrections invalidate dependent summaries; secrets remain inaccessible through summaries, caches and semantic search; switching model preserves the same authorized canon. Compare retrieval precision/recall, contradiction rate, context size and latency against E0. Numeric performance targets follow measured local hardware baselines, not vendor marketing.

### E2 — Character bible and scene continuity (P1, large)

Add proposed contracts for identity, motivations, relationship stance, speech register, appearance references, bounded voice examples and current scene state. Keep stable traits, changing beliefs and author preferences separate. Persian requirements include natural dialogue, moderate pacing, RTL/Vazirmatn, and user control of protagonist speech and consequential actions. Generated events and state changes enter a review queue with source turn, before/after values, confidence and conflicts. Unknown preconditions remain unknown.

Acceptance: reject a delta without changing canon; accept it through one auditable command transaction; stale-revision acceptance fails safely; an NPC cannot acquire a secret from another scene; a style example cannot override world rules or user agency. Judge voice and pacing with a human rubric and live-model samples, not keyword checks.

### E3 — World library and guided session setup (P1, medium)

Offer create-world, resume-session, and start-from-template paths. A world template contains reviewed lore, character profiles, optional rules and opening-scene suggestions. An adventure references an immutable template version and evolves independently, with one clear way to return to its world and its own save. Preview imports, schema/version compatibility, provenance, collisions and untrusted instructions before committing. Allow local tags/search/sort and explicit session separation. Do not treat a branch as a replacement for a separately isolated workspace.

Acceptance: two adventures from one template cannot mutate each other; export/import retains IDs or reports an explicit remap; unsupported versions and malicious paths are rejected; reopen and full backup/restore preserve both sessions. A new user can reach a first scene without understanding the knowledge graph.

### E4 — Storyboard and publishing (P2, large)

Create an approved outline, editable scene/page cards, a reading view and local print/export. Images attach to page and character revision, with prompt, provider/model, reference asset, generation settings, license notes and cost metadata. Support uploaded art before requiring image generation. Regenerate one asset without rewriting other pages or canon. Narration is optional, with a language capability check, transcript and playback controls. Never promise Persian voice support before testing an actual adapter.

Acceptance: mixed Persian/English text and punctuation render correctly in reader and exported pages; a single-page edit preserves other assets; secrets/prompts/context are excluded from public artifacts by default; export preview lists exactly what leaves the workspace. Cancellation and provider failure leave the manuscript intact. Public hosting is separate, explicitly chosen scope.

### E5 — Optional mechanics and richer media (P3, large/uncertain)

The MNO UI inspection found settings and library patterns but did not verify an actual game. Before borrowing any mechanic, run a clearly disposable adventure and inspect character creation, checks, tracker persistence, save/load, map meaning and failure recovery. If adopted, record ruleset version, roll inputs/results, state deltas and review policy; maps must distinguish illustrative geography from canonical locations. Video, inpainting and outpainting follow E4 and require per-job budgets, cancellation, retry limits and asset lineage. Defer public communities and unrestricted autonomous NPC simulation.

## Sequence, dependencies and decision gates

E0 → E1 and E2 → E3 → E4 → E5. E3 discovery can happen earlier; full template serialization depends on stable E2 contracts. Relative effort labels are planning estimates, not delivery dates. Release hardening from ACCEPTANCE_MATRIX.md remains a parallel prerequisite, especially live Ollama, desktop packaging, browser workflows and restore drills.

Before each implementation slice, write the smallest end-to-end contract, migration/rollback plan, acceptance fixture, privacy boundary and affected modules. Likely owners: retrieval/context for E1; core commands plus narrative/provider contracts for E2; source/backup and UI for E3; new asset adapter and publishing UI for E4. These are suggested boundaries, not code instructions or approved schemas.

Decide after evidence: local embedding model and multilingual quality; profile versioning; scene-delta review granularity; world-package format; image/TTS adapter availability and licenses. Supermemory now advertises a local runtime, so evaluate both that and a small independently built retrieval projection on the same fixtures. Check the exact license, supported Windows packaging, offline network behavior, query/inference cost, latency, data export, forget versus erase semantics, recovery, and whether source citations survive extraction. Do not promote inferred memories automatically. Canonical SQLite and the command gateway remain authoritative whichever option wins.

## Risks and rejected shortcuts

- Automatic memory inference can turn fiction or speculation into apparent truth: preserve evidence and require review for canon.
- Compression can leak secrets or flatten contradictory beliefs: compile per actor and retain disputed provenance.
- Old facts can crowd out current context: evaluate relevance under fixed budgets.
- Consistent art is an aspiration until measured: use approved references and per-character review.
- Browser-local competitor storage is convenient but not a substitute for recoverable desktop backups.
- A creator-code backup that doubles as identity restoration is convenient, but creates a credential whose exposure transfers ownership; prefer encrypted, user-controlled recovery material and keep backup/restore semantics explicit.
- Open community catalogs need content safety, attribution/license metadata, trust signals and prompt-injection defenses. The current single-user local-first product has no reason to accept those costs yet.
- Whole-book regeneration creates unwanted drift: prefer selective revisions, an improvement over G's documented whole-story regeneration flow.
- Avoid copying external branding, content or proprietary internals. Adopt workflow ideas and independently designed contracts.
- No social publishing, connectors, paid services or broader cloud transfer are authorized by this plan.

## Completion record for this planning step

Delivered comparative review, source boundaries, prioritized packages, acceptance criteria and agent workflow documents. No application code, schemas, dependencies or runtime configuration changed. Competitor generation quality and current local runtime behavior remain untested. MNO screens were inspected without creating a world/adventure or changing preferences; gameplay and save round-trips remain follow-up validation. Supermemory's documented product semantics are reviewed, but its local binary, license, Windows fit, offline behavior, retrieval quality and cost have not been independently verified.
