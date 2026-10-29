# Story Studio enhancement plan

Date: 2026-10-29. Status: approved for implementation by the user; implementation in progress.

## Recommendation

Build an RPG-first authoring and play experience on the existing Lorethra core. The main path is create or choose a world, build a protagonist, then play or resume an isolated adventure. Establish world/adventure lifecycle and the deterministic RPG loop before adding deeper continuity and optional simulation; add illustrated publishing after play is stable. Do not replace canonical storage with a memory vendor or make video generation a release dependency. Finish existing integrity and desktop acceptance gates alongside this work.

## Implementation update

The current source has advanced beyond the initial v10 slice described below. See [the platform audit](STORY_STUDIO_PLATFORM_AUDIT.md) for the current must-have, should-have and could-have inventory, verified evidence and remaining release gates. The supplied MNO static pages, screenshots, changelog and paired world/adventure exports have now been reviewed. The practical translation is a shorter resume-first dashboard, collapsed setup tools, role-aware import, optional world-cast selection, coordinate-backed map details, and explicit separation of author-only thoughts/secrets from model context. This plan remains in progress.

The user approved implementation on 2026-10-23. The project now uses schema v14 and includes versioned worlds, isolated adventures, d20 checks, reviewed state, continuity panels, local assets/reader, `.lke-world` / `.lke-adventure` packages, and MNO `.mno-world` v1 / `.mno-adv` v2 import. The supplied world was imported through the gateway and the paired adventure was previewed and imported through the authenticated ASGI API in an in-memory database. The UI prioritizes Continue, provides shared library search with recent/A–Z sorting, keeps setup progressively disclosed, previews the selected hero/world before starting, and lets players add selected MNO world-cast NPCs without exposing private fields to model context. SQLite remains authoritative and canonical writes use the existing command gateway. This is partial progress, not completion of the whole plan.

## Evidence and limits

Public pages, the MNO RPG Engine browser interface, user-saved HTML/screenshots, the user-provided changelog and paired MNO world/adventure files were inspected on the dates above. Product descriptions establish advertised capabilities, not tested quality. No account or paid generation was used. The saved HTML was inspected as static content and scripts were not run. The supplied world and adventure were converted; the adventure was imported through authenticated ASGI into an in-memory database. Live MNO gameplay and Lorethra browser import were not exercised. This API-path check is not desktop or browser acceptance.

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
| P: advertised stats/checks/trackers/map/NPCs | RPG session state and checks were absent before this implementation | Ship the built-in visible d20 rule and trackers; add reviewed state, NPC and map suggestions with explicit limits | P1 core, then P2 |

## Work packages and acceptance

### E0 — Establish the quality baseline (P0, small)

Create a documented golden evaluation set before tuning retrieval: a secret known to only one NPC, future knowledge, a corrected belief, two conflicting accounts, a branch divergence, a long Persian conversation, and an empty-memory question. The repository already has relevant unit/API/browser acceptance evidence, but no fixed bilingual retrieval corpus or numerical baseline; preserve and extend that evidence rather than duplicate it. Record model, prompt version, source revision, latency and token estimates. Acceptance: every case has expected permitted facts, forbidden facts, and an inspectable context manifest. Zero forbidden-fact inclusions in deterministic retrieval fixtures is a release gate; live-model prose leakage is measured separately and cannot be claimed solved by retrieval tests alone.

### E1 — World and adventure lifecycle (P1, medium)

Keep world and adventure libraries distinct. Offer a short create-world path from a template, reviewed AI draft, or blank world; guide the user through protagonist setup and final adventure review. Pin an immutable world version to a separately isolated adventure. Preserve existing conversations as unbound legacy stories. Add versioned `.lke-world` and `.lke-adventure` packages with provenance, bounded parsing, safe paths, compatibility checks, duplicate-by-default behavior, conflict preview, and explicit replace action. Keep the full backup and restore path.

Acceptance: two adventures from one world cannot mutate one another; a new world revision does not alter a started adventure; import reports duplicate IDs and unsupported versions before commit; traversal/path attacks are rejected; backup/restore preserves both histories and assets; a new user reaches a first scene without using the knowledge graph.

### E2 — Playable RPG loop (P1, large)

Complete character setup, visible stats and trackers, the built-in d20 check, and a clear transcript/composer flow. The gateway calculates `d20 + current stat modifier` against a visible target and stores the inputs and outcome; a provider only narrates the result. Add edit, retry, delete and stop controls for turns with revision-safe history and cancellation that cannot save partial output. Generated changes to trackers, quests, locations, relationships and NPC profiles enter a compact review queue. The player can edit, accept selected changes, or reject them. Only deterministic consequences of approved rules may update automatically.

Acceptance: seeded checks produce exact results; accepted proposals commit through one audited transaction; stale proposals, rejected changes and provider failures leave canonical state and saved prose intact; an NPC cannot acquire a secret from another actor; the user retains control of protagonist speech and consequential actions.

### E3 — Continuity and memory lifecycle (P1, large)

Add the four Memories views: user-authored Notes with an on/off context switch, reviewable event memories, a rebuildable current Situation, and editable Open Threads. Add NPC profiles for identity, appearance, voice, motivations, relationships, actor-scoped knowledge, trackers, memories and current goals. Require an explicit choice to match a name to an existing NPC, link an alias, or create a new NPC. Apply workspace, branch, actor, review, visibility and time permissions before relevance ranking. Extend the existing manifest and show included/excluded context, source, revision and reason. Retain history; bound retrieval instead of deleting old records. Summaries are rebuildable projections with source spans and invalidation rules.

Acceptance: relevant late records survive a tight budget; stale summaries rebuild or are omitted; secret, future, private, unreviewed and other-actor facts stay out of every context path, including summaries; corrections retain provenance; switching model preserves the same authorized canon. Compare retrieval quality, contradiction rate, context size and latency against E0.

### E4 — Exploration and bounded simulation (P2, medium/uncertain)

Add optional maps whose generated places stay suggestions until reviewed. A player-selected travel action changes the current location through the gateway. Off-screen NPC simulation is opt-in and off by default; when enabled, run every five completed turns for at most two NPCs. Route proposed changes to goals, activities, whereabouts and memories through the same review queue. Do not run unattended simulations or advance time without explicit user intent.

Acceptance: suggested locations do not become canon before review; only player-selected travel updates location; disabled simulation makes no provider call or write; enabled simulation respects turn/NPC limits and cannot bypass actor knowledge or proposal review.

### E5 — Storyboard and publishing (P2, large)

After the playable RPG loop is stable, create an approved outline, editable scene/page cards, a reading view and local print/export. Images attach to page and character revisions, with prompt, provider/model, reference asset, generation settings, license notes and cost metadata. Support uploaded art before requiring image generation. Regenerate one asset without rewriting other pages or canon. Narration is optional and requires a tested language capability, transcript and playback controls. Defer video, public hosting, public catalogs and community features.

Acceptance: mixed Persian/English text and punctuation render correctly in reader and exported pages; a single-page edit preserves other assets; secrets, prompts and context are excluded from shared artifacts by default; export preview lists exactly what leaves the workspace; cancellation and provider failure leave the manuscript intact.

## Sequence, dependencies and decision gates

E0 → E1 → E2 → E3 → E4 → E5. Release hardening from ACCEPTANCE_MATRIX.md remains a parallel prerequisite, especially live Ollama, desktop packaging, browser workflows, import/export drills and backup/restore.

Before each implementation slice, write the smallest end-to-end contract, migration/rollback plan, acceptance fixture, privacy boundary and affected modules. Likely owners: workspace/library UI and package adapter for E1; gateway and turn/provider contracts for E2; retrieval/context plus NPC records for E3; simulation and map proposal flow for E4; new asset adapter and publishing UI for E5. These are suggested boundaries, not a reason to bypass the existing gateway or acceptance gates.

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

## Current implementation and evidence boundary

The MNO importer, source-role filtering, local archive preservation, world-cast selection, NPC private-data display, map presentation and resume-first dashboard are implemented. The MNO and adventure-package tests pass in the current Python runtime, and TypeScript checking passes. The Vite build and migration file-backed suite still need a clean environment run; the desktop, browser, live-provider and separate-device recovery gates remain open. Competitor generation quality and live MNO gameplay were not independently tested. Supermemory's local binary, license, Windows fit, offline behavior, retrieval quality and cost remain evaluation questions rather than dependencies.
