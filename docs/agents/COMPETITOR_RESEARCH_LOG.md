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

**Useful pattern:** Make world/template identity distinct from session/adventure state; provide direct resume, import and export; show the local data boundary and backup policy; offer model choice and disclose context limits; show searchable and filterable library cards. Lorethra already has full database backup and isolated workspaces, so the gap is a friendly world/adventure workflow and portable world package, not basic persistence.

**Fit and caution:** Keep community publishing deferred. A local catalog can borrow search, tags and separate session lists without public accounts, popularity counts or user-generated executable instructions. Never package a creator secret as ordinary backup data without explaining recovery implications and providing protected handling.

## Project-side evidence checked

- `PRODUCT.md` and `ARCHITECTURE.md` describe local-first canonical SQLite, reviewed proposals, actor-scoped memory, branches and recovery.
- `backend/lke/retrieval/context.py` filters by accepted status, narrative order, visibility and actor awareness, then applies a token budget. The compiled context is chronological; query relevance ranking is not part of this path.
- `backend/lke/api/app.py` feeds that bounded context to story generation and character-memory questions. Memory answers must cite included claim IDs, and empty eligible context skips the model. These protections are foundations to preserve.
- `frontend/src/App.tsx` includes character-memory Q&A and JSON story/context export. The source importer currently accepts plain text/Markdown and identifies PDF/Office ingestion as disabled. These are not missing features to propose again.
- `docs/ACCEPTANCE_MATRIX.md` already records broad unit/API and browser evidence. It explicitly says there is no fixed bilingual evaluation corpus/numeric target yet; E0 should turn existing cases into a stable regression set.
