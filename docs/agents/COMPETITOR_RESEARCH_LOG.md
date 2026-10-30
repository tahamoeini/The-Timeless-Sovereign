# Competitor research log

Inspection date: 2026-10-23. This log records publicly visible features and claims to inform a local-first Story Studio plan. It is not a benchmark, endorsement or implementation specification. Repository code was inspected read-only. MNO settings screens were opened without changing preferences; no game, world, account or generated media was created.

## Gemini Storybook

**Evidence:** [Official Storybook page](https://gemini.google/overview/storybook/) and its FAQ.

The page describes a ten-page personalized illustrated book generated from a prompt, with optional files, photos and drawings. It advertises reading, listening, printing and public-link sharing, and says stories can be created in 45+ languages. The FAQ qualifies this: narration supports fewer languages, text cannot be edited in place, and conversational changes regenerate the story and all images. The page allows both family-memory fiction and explanations based on uploaded reports.

**Useful pattern:** A finished, navigable artifact gives the user a satisfying endpoint beyond a chat transcript. Offer page-level text and image editing, print-friendly layout, local export, and language-specific narration capabilities. Use an explicit source-to-fiction boundary for personal notes and imported documents.

**Do not copy blindly:** Whole-book regeneration can disturb approved text and visual continuity. Lorethra should keep the user in control of per-page edits and exclude prompts, private context and source files from shared artifacts by default. The Gemini page's sharing model is account-dependent and conflicts with Lorethra's local-first default unless the user chooses a specific export destination.

## Story Studio AI

**Evidence:** [Official product page](https://story-studio.ai/).

The page presents four workflows: Story Chat, Story Creator, Story Illustrator and Playground. It advertises character chat, branching interactive stories, illustrations based on PDF/TXT/pasted text, consistent art across scenes, image repaint/extension, and animation of an image or a longer video with voice. It describes character consistency and broad creative freedom as product claims; this review did not log in, generate a sample or verify its policies, quality, credits, licenses, or operational constraints.

**Useful pattern:** Offer a natural conversation for initial creation, then expose structured author controls; turn an existing manuscript into a storyboard; reuse character references between scenes; revise a single image region without rebuilding an entire story. Generate an outline first and let users approve before spending effort on assets.

**Fit:** The current project is text-first and has no illustrated asset workflow. A local page/scene reader and optional image adapter are practical after E0/E2. Video, voice, inpainting and outpainting are expensive, model-dependent, and should remain later optional adapters. The product's claimed consistency needs its own evaluation rubric.

## Supermemory

**Evidence:** [Product page](https://supermemory.ai/product/), [official docs index](https://supermemory.ai/docs/llms.txt), [API reference](https://api.supermemory.ai/reference), [API changelog](https://supermemory.ai/changelog/api/), and [memory lifecycle explanation](https://supermemory.ai/blog/memory-lifecycle-retention-corrections-deletion/).

The product separates source documents from extracted memory objects and describes four relation/lifecycle cases: a new fact can update current truth while retaining history, extend existing detail, derive an inference, or stop appearing in recall. It distinguishes durable facts, preferences and episodic memories. Profiles hold standing context; search can combine semantic recall, source chunks, graph relations, filters and reranking. The product documents low-confidence inferred memory review, document ingestion states, namespace scope, and a local runtime advertised to use local embeddings and configurable local model inference.

The API supports scoped namespaces and metadata filters, asynchronous ingestion and semantic/hybrid search. The product explicitly warns that a namespace is a selection scope, not authorization by itself. Its lifecycle documentation distinguishes hiding from permanent erasure: a forgotten memory can be excluded from ordinary search while the record remains stored. Source documents and derived memories have separate management paths. The API changelog announces v5 on 2026-10-07; any technical evaluation must use current v5 docs and pin the API version rather than copy older v3/v4 examples.

**Useful pattern:** Query context for relevance only after authorization filtering; retain typed time and links to original evidence; separate profiles from question-specific retrieval; review inferences; show users what context was selected; define correction, expiration, hiding and deletion as distinct actions. Build a golden query set and score retrieved context before judging answer prose.

**Fit and caution:** Lorethra already has canonical claims, accepted/rejected review, actor-awareness, source evidence, revision history, branches, a context manifest and backup/restore. A memory service must not become a second truth store. Evaluate the advertised local server against a lightweight Lorethra retrieval projection on the same test set. Verify Windows support, exact license, offline network traces, encrypted storage, exports, cache invalidation, forgetting/deletion, source provenance and cost before any adoption. A generated inference should never silently cross from character belief or story suggestion into canon.

## MNO RPG Engine (Perchance)

**Evidence:** [Live engine](https://perchance.org/mnoengine), inspected through its visible browser interface. The claims below are UI-level observations and advertised descriptions, not gameplay validation.

The navigation separates **Worlds** from **Adventures**. World setup describes scenario, lore, stats and trackers; the AI-craft card says it can draft lore, cast, stats, trackers and an opening scene. The new-adventure dialog asks the user to choose a world and states that an adventure remains bound to it. The adventure collection offers search, filter by world, sorting, grouping, and import of `.mno-adv`; the world collection supports `.mno-world` import. The public Explore catalog displayed 118 worlds with tags, author labels, likes and download counts. The content filter was off by default. These are strong library and onboarding patterns, while community publication brings moderation, attribution, safety and prompt-injection costs.

Settings disclose useful product boundaries. MNO offers Perchance AI, OpenAI, DeepSeek, OpenRouter and Ollama (local) for text, and Perchance AI, OpenAI and OpenRouter for images. It warns that the default text model has a small context window. Image controls include a global guidance-scale slider. The UI says data lives in browser storage and can be cleared by the browser. Its backup screen reports storage, lets users download a full backup, and offers explicit merge and replace-all restore. The backup includes the creator code; the UI warns that importing it also restores identity. Identity recovery can use that creator code.

The welcome panel advertises skill checks, stats, trackers, map and NPCs, but this review did not start an adventure. We cannot assert that checks are deterministic or that tracker updates persist correctly. The cited features are design references for optional mechanics; Lorethra should use its own deterministic evaluator and reviewed, revisioned state deltas if it adds them.

**Useful pattern:** Make world/template identity distinct from session/adventure state; provide direct resume, import and export; show the local data boundary and backup policy; offer model choice and disclose context limits; show searchable and filterable library cards. At the initial project-side inspection these were usability opportunities beyond Lorethra's backup and workspace foundations. The current implementation now includes world/adventure workflows, portable packages, and lifecycle-aware libraries; end-to-end release acceptance remains tracked in docs/PROJECT_STATUS.md.

**Fit and caution:** Keep community publishing deferred. A local catalog can borrow search, tags and separate session lists without public accounts, popularity counts or user-generated executable instructions. Never package a creator secret as ordinary backup data without explaining recovery implications and providing protected handling.

## Project-side evidence checked

- `PRODUCT.md` and `ARCHITECTURE.md` describe local-first canonical SQLite, reviewed proposals, actor-scoped memory, branches and recovery.
- `backend/lke/retrieval/context.py` filters by accepted status, narrative order, visibility and actor awareness, then applies a token budget. The compiled context is chronological; query relevance ranking is not part of this path.
- `backend/lke/api/app.py` feeds that bounded context to story generation and character-memory questions. Memory answers must cite included claim IDs, and empty eligible context skips the model. These protections are foundations to preserve.
- `frontend/src/App.tsx` includes character-memory Q&A and JSON story/context export. The source importer currently accepts plain text/Markdown and identifies PDF/Office ingestion as disabled. These are not missing features to propose again.
- `docs/ACCEPTANCE_MATRIX.md` already records broad unit/API and browser evidence. It explicitly says there is no fixed bilingual evaluation corpus/numeric target yet; E0 should turn existing cases into a stable regression set.

## Follow-up MNO evidence from supplied snapshots and exports (2026-10-29)

Taha supplied saved `MNO RPG ENGINE — Perchance.html` pages, their asset folders, map/NPC-panel screenshots, the MNO changelog, a `.mno-world` file and a paired `.mno-adv` file. The saved `Perchance2_files/mnoengine.html` snapshot was inspected as static HTML; its scripts were not executed and the downloaded page was not used to claim working gameplay. The screenshots are direct evidence of one rendered Map panel and NPC Profile, Memory and Life views, not evidence of runtime behavior.

The saved UI text exposes a concise primary navigation for Worlds, Adventures and Explore, with Tavern and Settings separated. In play it places Story, Session and Memories beside a central transcript/composer, while Hero, Map, NPCs and Gallery are contextual tabs. The visible state includes trackers and a context-size indicator. The adventure library exposes search/filter/sort and a world filter; world setup contains import and backup paths. This supports a short dashboard and contextual panels, while Lorethra keeps multiplayer/community and online catalogs deferred.

The map screenshot shows a schematic grid, current-location pin, nearby location cards, descriptions, rough distance/bearing and explicit Travel buttons. The NPC view separates profile, owned memories and private life; it shows portrait, appearance/persona, relationship meters, political alignment, first/last-seen turns, mini-goal, whereabouts and activity. Lorethra now adapts the durable parts: coordinate-backed POIs and player-selected travel, expandable NPC profile/memory/life records, local portrait assets, and author-only secret fields. Lorethra does not infer distance units from MNO coordinates, silently simulate NPCs or copy MNO labels and artwork.

The supplied JSON files were parsed locally. The world file is 354,548 bytes and contains 44 lore entries, 7 stat definitions, 9 trackers, 15 NPC templates and an NSFW marker. Its formula/check/image settings are retained as source text but are not executed. The paired adventure is 277,833 bytes and contains 85 messages, 8 player actions, 1 encounter NPC, 7 map POIs, 2 portrait images and 8 inner-thought/meta messages. Historical `check` messages contain narration rather than a verifiable die roll. Current converter/API fixtures pass. The exact world was imported through the gateway, and its paired adventure was converted, previewed and imported through authenticated ASGI into an in-memory database. This verifies this import path without exercising the browser or model, and does not validate MNO gameplay quality.

**Practical adaptation:** use separate world and adventure libraries; put Continue first and collapse setup/import tools; keep play central and detail in optional panels; let users select from a reusable world cast; preserve role and author-only distinctions during imports; show coordinate maps with a parallel accessible POI list; and review imported memories/state instead of assuming that old narration is canonical. Search, filters, sorting, lifecycle actions, and a short setup review now exist in Lorethra. Their full browser and installed-desktop acceptance remains open; see docs/PROJECT_STATUS.md.

## Live home-page comparison and saved-story UX audit (2026-10-30)

**Evidence reviewed:** [MNO RPG Engine](https://perchance.org/mnoengine) in its live page, the supplied MNO and Lorethra saved HTML pages, and the two supplied adventure transcripts. The saved HTML was inspected as text and was not executed. The MNO start/setup path was opened without saving a hero or starting a persistent adventure.

MNO's live home page makes three next steps easy to recognize: **Begin Your Adventure**, **Create world**, and import. It gives a short explanation of each and a visible local-storage/backup notice. The world-selection dialog briefly explains that an adventure stays bound to its chosen world. The hero wizard has four tabs—Bio, Avatar, Stats, Review—and still asks for several fields and art choices. That is a useful start-first pattern, not proof that the whole product is simple for every user.

The supplied Lorethra saved page puts repair search, backup/restore, refresh, filters/sort, create/continue, export choices, and the first setup step in the same visible area. That is a high competing-action count for someone who only wants to continue a story. The current source changes reduce turn-level buttons, move character/game controls behind one named disclosure, keep the story composer as the primary task, and expose pending review counts where the review queue is collapsed. Source review cannot establish that people will understand these choices; the local app was not available for a rendered comparison in this inspection.

The supplied 33-turn MNO adventure transcript visibly presents `Roll` results and `EXPERIENCE` cues in the story flow. This establishes how those events appear in the supplied transcript, not MNO's underlying random-number generation, formulas, automatic reward calculation, or state persistence, so this log makes no such parity claim. Lorethra's automatic outcome selection is implemented with its own pinned rules and gateway checks; MNO formulas and source settings remain untrusted preserved text. In the current web text extraction, the live Perchance page exposed its outer prompt and an iframe, but not the embedded RPG interface; the supplied saved page and transcript were inspected statically and their scripts were not executed.

**Product decisions:**

- Put the next player action first; move repair, backup, export, and diagnostic controls out of the ordinary play surface.
- Show a check and its consequences as one story result. Lorethra asks the provider for both possible narrative outcomes in one response, rolls locally, and commits only the matching branch with the validated check, avoiding a second provider call.
- Use automatic XP by default for new worlds and MNO imports. Preserve the behavior pinned in older worlds rather than silently changing existing adventures.
- Evaluate beginner comprehension by task completion with a novice, narrow-window rendering, keyboard-only navigation, visible pending reviews, and a reload/branch-isolation check. Those runtime checks remain open.

**Implementation follow-up (2026-10-30):** The active Story Studio now collapses the worlds/adventures library and setup while an adventure is open, groups character, mechanics, memory, NPC, map, and context panels under **Adventure details & tools**, folds repeated save/context provenance under **Turn details**, and moves older-conversation import behind its own disclosure. On first library load, the three-step setup is closed until the user chooses **Start your first adventure**; returning players see resume choices first. The flow is now **World → Hero → Review**. A deterministic, balanced starting sheet is prepared when pinned rules permit one; attribute editing is optional, and new worlds with unreachable point budgets cannot be saved through the UI. World creation asks for a name, style, and optional idea; the suggested starting place is added to the map, while extra places, opening-scene writing, cover art, and advanced rules remain collapsed. The active story and composer remain the main play path; review counts remain visible. Manual roll/XP controls remain only for pinned world rules that allow them; new worlds and MNO imports already use Lorethra's automatic checks and per-turn XP. The source build passes, but screenshot, first-use browser, novice, keyboard, and installed-desktop review remain open.

## Continuity evaluation references

- [MemGPT](https://arxiv.org/abs/2310.08560) motivates separating bounded active context from longer-term memory.
- [Generative Agents](https://arxiv.org/abs/2304.03442) describes retrieval using relevance, recency, and importance.
- [LongMemEval](https://arxiv.org/abs/2410.10813) treats extraction, multi-session and temporal reasoning, knowledge updates, and abstention as distinct evaluation tasks.

These are research directions, not proof that a particular retrieval strategy solves continuity. Evaluate any change against fixed local fixtures, source provenance, actor/time authorization, and measured baselines before adjusting defaults.
