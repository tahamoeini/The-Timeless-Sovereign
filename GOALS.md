# Lorethra — Product Experience Goals

**Repository:** `tahamoeini/The-Timeless-Sovereign`  
**Product:** Lorethra, including Story Studio, Knowledge Explorer, Journal & Memory, and Decision & Scenario Lab  
**Status:** Proposed product/UX direction and implementation acceptance contract — **not** a claim that the redesign is implemented  
**Prepared:** 2026-10-30  
**Applies to:** First-run experience, navigation, all user-facing screens, story creation and play, editors, forms, libraries, review flows, settings, accessibility, and frontend architecture

> **North star: Extraordinary depth underneath. Extraordinary simplicity on the surface.**
>
> Someone who has never used Lorethra should be able to understand what to do next, begin something meaningful, and recover from a mistake without understanding databases, AI providers, branches, revisions, context manifests, simulation engines, or canonical data models. A practiced user must still be able to reach the full capabilities when they need them.

---

## 1. Product purpose and the actual user promise

Lorethra is a **local-first platform for making, experiencing, remembering, and exploring connected worlds and knowledge**. It has one durable, user-owned knowledge and memory core, with four related experiences:

1. **Story Studio:** Create or import a world, prepare a hero, play and continue an immersive adventure, remember characters and events, inspect changes, and read or export the story.
2. **Knowledge Explorer:** Keep sources and evidence, understand people/ideas/relationships, review proposed discoveries, and correct the record.
3. **Journal & Memory:** Capture accounts and notes, revisit them through time, preserve their sources, and revise them without erasing history.
4. **Decision & Scenario Lab:** Explore questions and alternative outcomes without changing established facts unless a later, explicit review permits it.

These are not four disconnected mini-products. They are accessible doors into the same reliable local-first system. **Story Studio is the primary, fully developed experience for the first release**; the other workspaces must remain available without dominating its first-run UI. The product should feel coherent to a storyteller, reader, note-taker, researcher, or advanced world builder.

### The promise in ordinary language

- **Make something:** “Create a world,” “Start an adventure,” “Add a note,” or “Explore an idea.”
- **Continue effortlessly:** “Pick up where I left off” must be obvious.
- **Stay in control:** “Nothing changes my established world or trusted notes without my approval.”
- **Understand the consequence:** Before sharing, importing, restoring, or applying a change, know what will happen and what will not happen.
- **Own the result:** Stories, notes, history, and backups stay accessible and portable without forcing a paid cloud provider.
- **Grow into power:** Advanced options are present when relevant, never demanded in advance.

**Primary product outcome:** The user completes a meaningful first journey, returns later, and resumes confidently. The number of available configuration fields, dashboard widgets, or visible technical controls is **not** a success metric.

## 2. The non-negotiable design philosophy

### G1 — Progressive complexity, not diminished capability

**Default to the smallest interface that can complete the current task.** Advanced mechanisms may be sophisticated; their complexity is not a reason to make the user operate them manually.

- Present one clear primary action per task state and a small number of understandable secondary actions.
- Surface a setting only when the user can explain why it matters **now**.
- Put specialist functionality behind contextual **More options**, **Customize**, **Details**, or a clearly named advanced workspace.
- Reveal additional options when required by the user's choice, not by showing every possible field from the beginning.
- Preserve all supported data and advanced functions. Hiding a control must not delete its feature or silently change semantics.
- Prefer excellent defaults, templates, examples, safe auto-filled values, and previews over repetitive questions.
- Avoid making a user choose a “mode” before they understand what they are doing; sensible defaults precede customization.

**Anti-goal:** Replacing a sprawling page with ten layers of obscure accordions. Complexity must become **less work**, not merely less visible.

### G2 — A novice should understand the screen without a manual

The design must work for people unfamiliar with software, including young or older users, people with lower technical confidence, and experienced creators who are new to this product. This is a **cognitive-accessibility standard**, not a reason to patronize or infantilize people.

- Speak in the user's vocabulary: “My stories,” “Characters,” “Story details,” “What changed?” and “Keep these changes.”
- Reserve “snapshot branch,” “expected revision,” “epistemic status,” “context manifest,” “idempotency,” and similar implementation terms for Advanced/technical details.
- Pair jargon with plain-language explanations wherever technical accuracy requires the term.
- Prefer recognition, examples, and visible choices over memory and multi-screen instructions.
- Tell users why information is requested and whether it is optional.
- Never require JSON editing, entity IDs, raw model IDs, database concepts, or developer tools for a normal journey.
- Offer guidance in place, not through a mandatory tutorial or a forest of tooltips.

### G3 — Task-first, content-first, narrative-first

Lorethra is not primarily a business-intelligence dashboard. Dashboards are useful only where the user needs an overview or a decision. **The story and the act of writing/playing are the main content.**

- In an active adventure, the current scene and input composer command the screen.
- In libraries, the next action and recognizable items take priority over metrics.
- In Knowledge, show the source/map/idea that matters; do not make seven technical views compete equally.
- In Journal, emphasize the note or timeline, not database administration.
- In Scenarios, emphasize the question and comparison, not the rule engine's schema.
- Do not fill otherwise useful space with decorative KPI cards, technical counts, or ornamental complexity.

### G4 — Deep power, explicit control, zero surprise

Every simplification must preserve user agency, correctness, traceability, privacy, and recovery. A short flow is not allowed to hide a consequential side effect.

- AI text, extracted candidates, simulation suggestions, and changes to world or character state remain **proposals** until permitted review/commit.
- A user-controlled protagonist's actions, thoughts, commitments, and dialogue are never silently invented by the system.
- Public, actor-scoped, author-only, and private information must remain correctly distinguished even when the UI uses friendlier labels.
- Remote AI transfer is off by default and needs matching, informed provider-specific consent; show a comprehensible summary of what may be shared.
- Destructive and privacy-sensitive actions require appropriately scoped review and confirmation; do not blanket-confirm harmless actions.
- Background automation may organize the UI, compute previews, or prepare drafts, but must not silently accept canon, promote a branch, export private content, or change protected data.

### G5 — A unified experience, not a collection of forms

Screens, navigation, nomenclature, controls, states, typography, spacing, keyboard behavior, and feedback should follow one design system. Each workflow should feel related to the others, with consistent patterns for **Create → Review → Save**, **Propose → Review → Accept/Reject**, and **Open → Edit → Save**.

---

## 3. User needs and default experience levels

The product must support **experience states rather than crude age or expertise assumptions**.

| User situation | Main need | Default presentation |
| --- | --- | --- |
| First-time or low-confidence user | Know where to begin; avoid fear of breaking things | A welcoming landing state, explicit **Start an adventure** / **Continue**, templates, simple language, few decisions |
| Casual storyteller or reader | Immerse in a story, type a response, follow characters | Distraction-free reading/play; contextual character and location access |
| Returning user | Resume with continuity; understand recent changes | Recent adventure front and center; short, optional recap |
| World builder / author | Compose setting, characters, opening scene; tune rules when needed | Guided creation first; structured authoring tools on demand |
| Researcher / knowledge curator | Preserve evidence and confidently review claims | Source-first flows and an intelligible review queue |
| Advanced operator | Inspect memory, branches, provider settings, revisions, mechanics, imports, and recovery | Explicit advanced views with complete fidelity and no loss of capability |

**Simple experience** is the default, including for existing users unless an existing preference has been explicitly saved. **Advanced capabilities** should be available via contextual entry points and an optional persistent “Advanced tools” preference; do not fork the data model or create two divergent implementations. Switching views must be reversible and preserve unsaved work. A preference is a presentation choice, **never a permission or security boundary**.

## 4. Primary information architecture

### G6 — Simplify the navigation around user intent

**Proposed first-level navigation:**

- **Stories** — Home, adventures, worlds, heroes, play, reading.
- **Knowledge** — Sources, explored concepts and connections, reviews.
- **Journal** — Notes, events, timeline.
- **Explore scenarios** — Questions and alternatives.

The first-run home should heavily favor **Continue story**, **Start a story**, and **Import a story/world** where supported. Less-used product areas may appear in a compact **Explore more** region, but must not become inaccessible or deceptively absent. Consider labels and discoverability in usability tests rather than treating this navigation proposal as final fact.

**Move out of global chrome:** database revision chips, branch selectors, rebuilding search indexes, provider technical diagnostics, JSON exports, and general maintenance. These belong in appropriate **Advanced**, **History**, **Settings**, or **Help & recovery** destinations. Display an important exceptional state globally only if immediate action is needed.

**Keep globally accessible:** clear location/context, Back where expected, workspace identity when needed, privacy/status when meaningful, settings/help, and visible progress or error feedback.

The UI must make it obvious which world or adventure is open, while technical branch/revision IDs remain available in advanced detail panels.

### G7 — A calm, meaningful home screen

**Empty state:** One welcoming sentence, a compelling primary button, a simple alternative to import, and a brief explanation that work stays local. A first-time user should not see an administrator console.

**Returning state:** A recent adventure card with its cover or distinguishing name, **Continue**, a recognizable world/hero, and short story progress context. Additional adventures are searchable below. Other workspaces and unfinished reviews are discoverable, not visually competing with Continue.

**No false affordances:** If a model is not configured, do not claim AI narration is ready. If a library is empty, offer a real next step. If a feature is unfinished, do not render it as a working primary action.

## 5. Task-by-task experience goals

### G8 — Start a first adventure without understanding the engine

**Target mental model:** “Choose a world → Choose a hero → Begin.”

- Prefer familiar starter world templates or existing/imported worlds over a blank world-definition database form.
- Give each setup step one understandable question or cohesive decision. Make optional details truly skippable.
- Keep story/model configuration out of the hero-creation step unless an AI model is actually required for the next action. Explain available offline mechanics and any limits without a model.
- Show a short, human-readable final review: world, hero, opening premise, and any consequential sharing or generation choice.
- Preserve the world-pinned creation contract and deterministic validation. When point allocation is required, present a friendly character builder with clear remaining points, bounds, and Reset; do not silently change invalid allocations.
- The user may revise choices without losing earlier inputs. Preserve drafts across Back/Next navigation and recover from errors.
- Prefer user-facing terms such as **Choose abilities** and **Character attributes**; show rule IDs, numeric engine parameters, and simulation controls only for advanced authoring.
- World Architect is optional and local Ollama-only where implemented: draft → preview → explicitly apply → edit → explicitly save. It must not become an automatic canon-authoring step.

**Acceptance example:** A person who has never seen the product can create an adventure from a suitable starter/default configuration without visiting Knowledge Explorer, editing JSON, managing branches, or interpreting an API/provider manifest.

### G9 — Make world creation welcoming, expandable, and efficient

The current three-stage world editor is a foundation; **fewer stages alone are not proof of simplicity**.

**Default path:**
1. **Name and imagine your world:** a title, an optional one-sentence idea, and a recognizable style/template.
2. **Set the beginning:** an optional starting place and opening scene (or an explained default).
3. **Review and create:** a short visual summary and primary **Create world** button.

**Advanced path:** World mechanics, custom dice/skills, creation-point budgets, tracker definitions, exceptional-ability schemas, lorebook activation, NPC templates, imports, and version management. Organize advanced authoring into distinct focused editors; avoid a single giant expandable form.

If later steps contain conditional technical requirements, explain them at the point of use, auto-fill only policy-safe defaults, and show exact actionable validation messages. Allow the user to create a valid simple world without entering coordinates, custom attributes, special abilities, or technical metadata. Preserve immutable world-version semantics and the gateway's validation.

### G10 — Put play and reading before controls

**When a story is open, the default visual hierarchy is:**

1. Current scene / conversation in comfortable reading typography.
2. A prominent, clear **What do you do or say?** composer and Send/Continue action.
3. Essential context only: hero, current place, and a few relevant status indicators when the chosen world uses them.
4. On-demand **Characters**, **Memories**, **Map**, **Character sheet**, **Story history**, **Illustrations**, **Reader**, and **Story options**.

Use a focused reading area, restrained panel density, and appropriate line length. Do not permanently surround every narrative turn with mechanics editors, NPC maintenance, memory query forms, provenance tables, or context diagnostics. Avoid forcing players to look at administrative actions after every response.

**Mechanics and state:** Show a roll or changed resource when it is meaningful, with an accessible explanation. The deterministic result still comes from gateway/API rules. Review state proposals using concise before/after cards (“Health: 8 → 6”), with clearly distinguished **Accept**, **Edit**, and **Reject**. Hide raw operation codes but keep details available.

**Long stories:** Preserve input focus and draft text; support readable scrolling, a jump-to-latest control, accessible loading/generation status, Cancel and safe Retry, and clear distinction between a generated response and a committed one. Prevent accidental duplicate turns on reconnect/retry.

**Reader:** Offer a visually distinct, distraction-free read/print experience. It should be an intentional presentation of active story content, not a technical transcript dump. Do not expose hidden/private author text in the default reader or share/export flow.

### G11 — Make libraries useful, not crowded

- Continue/Resume must be the dominant action on each active adventure.
- Search visible when there is enough content to search; offer simple status/count and a “Clear filters” escape hatch.
- Keep common sorting sensible; advanced filters remain in one compact place and clearly indicate when applied.
- Cards use distinguishable titles, cover/hero/world context, and legible statuses rather than serial numbers, IDs, and densely packed metadata.
- Rename, duplicate, status management, archive/restore, package export, and maintenance go into a predictable **More** menu or item details page.
- Preserve archived content and explicit recovery; archived items cannot be mistaken for playable items.
- For large libraries, use pagination/virtualization or staged loading where necessary **without sacrificing discoverability**.
- Separate **Worlds** and **Adventures** when that improves recognition, while preserving the ability to start a new adventure from a world.

### G12 — Knowledge Explorer: start from an idea or source, not a schema

The existing seven knowledge views (map, matrix, records, history, evidence, extraction, review) must not all compete at first glance.

**Default:** Browse or search ideas/sources; start with **Add a note/source** or **Add an idea**; see understandable connections. Favor a source-centered view or simple map as supported by actual user testing.

**Contextual actions:** Open a concept to edit it; open a relationship to inspect or correct it; open **Needs review** when proposals exist. Editing properties, status, visibility, evidence, and revisions should happen within focused detail/editor views—not as multiple long forms shown next to every map.

**Advanced:** Relation matrix, raw property/JSON editor, revision ledger, source extraction provenance, context diagnostics, and batch review. These capabilities remain accurate, findable, and accessible.

**Human review:** Translate technical claim metadata into understandable explanations without collapsing epistemic uncertainty into “true/false.” Distinguish **Accept into my records** from **I know this is true**. Show source quote, trust/uncertainty, privacy scope, consequences, and a way to correct or reject.

### G13 — Journal: write first, organize later

- Emphasize **Write a note** and **Read my timeline**.
- Use friendly date controls, with honest support for exact, approximate/ranged, relative, or unknown time; never invent dates.
- Keep source references and participant links as optional context until needed for a governed operation.
- Display the account and its date in readable form; expose version history and correction provenance on demand.
- Preserve conflicting accounts rather than merging or silently overwriting them.
- Make revisions understandable as “Updated account; earlier version kept” rather than database terminology.

### G14 — Scenarios: guide a human question before a rules engine

- Start with **What are you trying to decide or explore?**
- Prompt for two or three understandable options and optional assumptions; use example questions.
- Show a simple side-by-side comparison focused on differences and uncertainty.
- Explain that the exercise is a separate “what-if” version, leaving original knowledge untouched.
- Rules, claim references, explicit branch IDs, hard/soft constraints, promotion, and revision review are advanced details.
- Do not imply forecasting accuracy or model-generated recommendations that the product does not actually provide.
- Promoting any scenario change into a parent branch remains a separate, explicit, fully reviewed operation with stale/conflict safeguards.

### G15 — Settings, AI providers, import/export, and recovery

**Settings:** Separate **Appearance & accessibility**, **AI for stories**, **Data & privacy**, and **Advanced tools**. Avoid a single catch-all list of technical switches.

**Model choice:** Provide simple descriptions (local/on this device vs online/external), availability, setup help, and clearly labeled manual selection where supported. Do not force provider choice at startup. Advanced users may specify provider/model and inspect capability/limitations; retain their deliberate selection. Never assert a provider is free, private, or working without verification.

**Consent:** Before an external request, describe the recipient, purpose, and categories of permitted context in plain language, give a way to inspect details, and require specific informed opt-in. Declining must preserve all local work. Consent revocation must be understandable and available.

**Import:** Drop/select file → safe preview of recognized content and possible warnings → explicit import. Handle malformed, tampered, oversized, unsupported, or mismatched packages without data loss. Explain whether import creates a new world/adventure or only a separate transcript archive.

**Export:** Start with **Save a copy** / **Share a copy**. Explain clearly what each export includes/excludes. The full-private archive requires explicit, context-appropriate confirmation. Never conflate a portable world/adventure package, a story reader export, a context manifest, and a full backup.

**Recovery:** Offer **Back up my data** and **Restore from backup** with human-readable consequences and backup scope. Advanced repair (e.g., search-index rebuild) lives in troubleshooting; it should not occupy the normal global toolbar. Test destructive restore, failure and rollback paths.

---

## 6. Interaction standards for every page

### G16 — Forms and wizards should be short, forgiving, and justified

- Every form must identify the user outcome and the **minimum truly required inputs**.
- Group related information; provide defaults, inline examples and friendly field descriptions.
- Reveal conditional fields only if relevant; preserve entered values when sections close or steps change.
- Use the correct native input control and input semantics; avoid asking for JSON, raw identifiers, or comma-separated pseudo-schemas in ordinary flows.
- Validate near the field and before consequential submission. Errors explain what to do, not just why a payload is invalid.
- Do not erase a form after failed submission; distinguish blocking errors, warnings, and nonblocking suggestions.
- For long advanced forms, provide useful sections, draft preservation, jump-to-error, and stable Save/Cancel actions.
- Make cancellation behavior explicit when a draft will be lost; do not create unnecessary confirmation dialogs.
- A wizard step is justified only if it represents a real decision or reduces cognitive load. Do not split simple tasks into unnecessary steps.

### G17 — Make every state understandable

Every meaningful interaction must cover **loading, empty, success, validation error, permission/consent rejection, stale revision, offline/unavailable model, cancellation, partial recovery, and retry** where applicable.

- Provide immediately perceptible feedback and an actionable next step.
- Preserve the user's text and selections across retriable failures.
- A stale write must never silently overwrite newer data. Explain, refresh/review, and offer safe retry where permitted.
- Never display a spinner forever; expose cancellation and meaningful recovery where supported.
- Keep warnings contextual and concise; do not bury them in a technical console.
- Present pending AI proposals separately from accepted records; include accessible statuses that do not depend on color alone.

### G18 — Clear visual language and a restrained design system

The desired look is **a calm creative studio and readable book**, not a control room or a generic enterprise dashboard. A coherent dark theme may suit a narrative product; it still needs excellent readability, and a light/high-contrast alternative should be considered based on evidence and feasibility.

Design tokens and components should govern:

- Type scale, line height, content measure, color semantics, contrast, focus treatment, spacing, radii, elevation, and motion.
- Consistent navigation, cards, scene/reader blocks, dialogs, menus, disclosures, buttons, inputs, toasts, review cards, and form errors.
- Clear headings and content grouping; generous whitespace; restrained accent colors and meaningful imagery.
- **Practical design targets:** default body and form text approximately **16 CSS px**, secondary/help text normally **14 CSS px or larger**, comfortable reading text around **16–20 CSS px**, and common interactive targets **44 × 44 CSS px where practical**. These are proposed product standards, not all WCAG AA minimums.
- Avoid tiny all-caps metadata, dense text walls, low-contrast gray-on-black, toolbars full of same-weight buttons, and one-screen collections of nested forms.
- Avoid relying on color, icons, hover, or animation alone to carry meaning. Provide text labels and status.

**Current code warning:** `frontend/src/styles.css`, `workflow.css`, and `story-studio.css` contain many 7–10px declarations. Audit effective typography in rendered screens; replace microtype with a consistent accessible scale rather than making isolated overrides.

### G19 — Accessible, responsive, multilingual by design

**Minimum conformance target:** WCAG **2.2 Level AA**, validated against actual supported webview/browser behavior, not merely asserted by automated checks.

- Keyboard operation, visible and unobscured focus, logical focus order, clear labels, meaningful landmarks/headings, accessible dialogs/menus/disclosures, and screen-reader announcements for status.
- Correct contrast, text resize and reflow, zoom, reduced-motion support, non-drag alternatives, and usable validation.
- Treat **44 × 44 CSS px** as the preferred touch/target size where feasible; recognize that WCAG 2.2 AA target-size minimum and exceptions differ.
- Test at common desktop widths and constrained windows (including approximately 320–400 CSS px). Eliminate horizontal scrolling for standard content, except where legitimately necessary for complex data visualization.
- Preserve language-specific and mixed-direction content with `dir="auto"` or equivalent for narrative/user text. Provide right-to-left-ready layout, logical spacing properties, and full Persian/English text rendering as an acceptance requirement, not a late CSS patch.
- Prefer simple internationalizable strings over English text embedded across complex components. Do not assume all users read English or use a Latin keyboard.
- Accessibility does not mean making every page look childish. Favor dignity, readability, and autonomy.

### G20 — Fast perceived performance and smooth continuity

- Prioritize immediate rendering of the current task, recent stories, and the active scene rather than loading all unrelated domain records or media before interaction.
- Add page/workspace scoped loading and request cancellation or stale-result suppression as appropriate.
- Make libraries scale with realistic numbers of worlds, adventures, memories, and long transcripts.
- Avoid unnecessary rerenders from large shared state; paginate or virtualize large content only where it actually improves performance and does not break keyboard/search usability.
- Keep long narrative input safe during navigation, generation, transient errors, and window resizing.
- Use explicit progress for imports, AI generation, downloads, and recovery where measurable; do not invent percent complete.
- Budget and measure performance on realistic Windows desktop hardware before defining final numeric thresholds.

---

## 7. Frontend engineering goals (without weakening the core)

### G21 — Separate domain complexity from presentation complexity

The current frontend has substantial user-facing behavior concentrated in `frontend/src/App.tsx` (over 5,000 lines), alongside `api.ts`, `storyMechanics.tsx`, and several stylesheets. This is a **maintainability and consistency risk**, not evidence that any single feature is wrong.

**Target direction, not a required file tree:**

- Reusable application shell and accessible navigation.
- Story, Knowledge, Journal, and Scenario feature areas with explicit UI boundaries.
- Shared primitives for form fields, dialogs, action menus, onboarding, review cards, status displays, disclosure, empty states, and notifications.
- Focused data-access/state hooks or services with scope-aware request handling.
- Clear distinction among **view models / understandable UI labels**, validated API contracts, and canonical domain commands.
- A token-based styling system rather than ad hoc microtype and deeply nested CSS overrides.
- Tests at component, flow, contract, and visual/accessibility levels.

Do **not** rewrite the backend, replace SQLite, bypass the gateway, create divergent frontend sources of truth, flatten provenance fields, alter package schemas, or remove advanced capabilities merely to simplify the UI. Do not run unrelated architecture migrations without separate evidence and approval.

### G22 — Keep product invariants testable through every redesign

The following rules from the existing repository remain binding:

1. SQLite is canonical; search, graph, and summaries are rebuildable projections.
2. All accepted writes go through the validated command gateway: scope → validation/authorization → commit → revision/audit → projection work.
3. Workspace and branch isolation, immutable pinned world versions, optimistic concurrency, idempotency, and explicit branch promotion remain enforced server-side.
4. Generated story text, extracted claims, NPC simulation, memory suggestions, and scenario changes do not quietly become accepted canon.
5. Character knowledge remains actor-, visibility-, time-, and revision-scoped; context previews and remote transmission obey the same server-side gates.
6. Provider-specific consent, remote-context redaction, cancellation semantics, private author material, and local-first behavior must not be weakened.
7. Imports remain validated/untrusted; package formats retain integrity and compatible migration behavior; exports and backups preserve intended privacy boundaries.
8. Revision history, corrections, recoverability, stored narrative turns, and reproducible deterministic RPG checks remain accurate.
9. Narrative guidance preserves protagonist agency, NPC autonomy, causality, continuity, and the player's chosen language and voice.
10. The default journey does not require a paid cloud API; do not promise local AI generation without a configured local model.

**Rule:** The simple UI may make an authorized operation easier to initiate, but cannot make an unauthorized operation possible or suppress material warnings needed for informed choice.

## 8. Evidence-led migration priorities

This document is a **goal and acceptance contract**, not a command to replace every screen at once. Deliver small, integrated, reversible slices ordered by user value and risk.

| Priority | Product goal | Required first implementation outcome |
| --- | --- | --- |
| **P0** | A comprehensible landing and primary navigation | A first-time user sees what to do; story resume/create dominate; technical controls move to appropriate advanced destinations |
| **P0** | Comfortable, accessible typography and controls | Remove inaccessible microtype from all core paths; keyboard/focus/contrast/responsive issues have verified fixes |
| **P0** | Frictionless Story Studio setup and play | Valid world/hero/adventure journey; scene and composer remain primary; options are contextual and review is safe |
| **P0** | Preserve integrity, privacy, and recoverability | No regressions to gateway, consent, branch/pinned-world behavior, packages, story history or existing tests |
| **P1** | Clear task-oriented Knowledge, Journal and Scenario flows | Source-first review, note-first writing and question-first scenario comparison; technical editors secondary |
| **P1** | Reusable UI system and safer frontend modules | Shared patterns and tests replace repeated sprawling JSX/CSS; no API/domain semantic drift |
| **P1** | Approachable AI and data operations | Guided provider setup; import/export/recovery with trustworthy preview/consent/failure paths |
| **P1** | Inclusive localization and responsive behavior | Verified keyboard, screen reader, RTL/mixed-direction, text scaling and constrained-window flows |
| **P2** | Polished long-form creative experience | Richer reading/authoring presentation, helpful contextual recaps, library scalability and user-configurable appearance |
| **P2** | Evidence-based refinements | Instrument only privacy-safe UX signals if appropriate; conduct usability research and iterate based on demonstrated friction |

**Implementation sequencing:** Establish a documented before-state → define tasks and expected experience → implement the smallest complete journey → test simple and advanced behavior → run domain/regression/security checks → perform hands-on usability and visual review → update acceptance status. No mass CSS-only redesign that leaves workflows confusing.

## 9. What success must be proven by

### Behavioral acceptance gates

All must pass for the affected flow:

- **First use:** A new user can identify the primary action, create or select a world and hero, and begin an available adventure path without editing IDs/JSON or touching unrelated workspaces.
- **Return:** A user with several saved adventures can locate and resume the intended one without navigating a maintenance console.
- **Play:** The active narrative and composer remain central at typical and narrow desktop widths; a user can generate, cancel/retry safely where supported, inspect consequential proposals, and continue without losing typed text.
- **Power-user parity:** Every previously supported advanced operation remains accessible through a discoverable path and maintains its original semantics.
- **Safe review:** A rejected or pending proposal never appears as accepted; an accepted one uses the command gateway and leaves appropriate revision/audit evidence.
- **Consent and privacy:** No outbound request without required matching consent; a refused/revoked consent leaves local content intact; exports accurately communicate privacy and require the correct level of confirmation.
- **Data integrity:** Workspace/branch isolation, stale-write behavior, immutable world-version pinning, deterministic checks, import validation, export/restore and historical revisions remain regression-tested.
- **Accessibility:** Keyboard-only and assistive-technology journeys succeed; WCAG 2.2 AA issues are triaged and verified; language direction and scaling do not prevent basic use.
- **Resilience:** Empty datasets, no-model state, model outage, cancelled operation, slow response, failed import, and restore failure each have a usable, truthful recovery path.
- **Visual consistency:** No unreadable microtext, overlapping UI, clipped controls, blocked focus, unintended horizontal overflow, or a wall of simultaneous forms on default paths.

### Usability research and measurement

Before claiming success, **measure baseline and redesigned behavior** with both first-time and experienced users. Include people with low technical confidence and older adults as appropriate; if children are real intended users, establish an age-appropriate privacy/content/safety and consent policy separately before testing/deployment.

Record at least: unassisted task completion, time and steps to first successful adventure, misclicks/backtracks, comprehension of provider consent and “proposed vs saved,” ability to find an advanced setting, recovery from a failed action, and perceived confidence. Include qualitative observation of hesitations, not only click metrics.

**Provisional pilot targets (to validate, not claims of current performance):**

- The majority of representative first-time testers can complete the chosen primary flow unassisted.
- No critical misunderstanding of a privacy/consent/canon decision.
- Task completion and confidence improve against the **measured** current UX baseline, without an unacceptable decline in advanced-task completion.
- Core tasks remain usable with text enlarged and at narrow window sizes.

Set any final numeric success thresholds after a baseline study and a representative test sample. Automated a11y scans, type checks, builds, and unit tests are essential but **cannot substitute** for observing real people.

### Release evidence

For each affected workflow, provide:

1. Before/after screenshots or recordings at representative window sizes and interaction states.
2. A before/after journey map and a clear inventory of hidden, moved, retained, or replaced controls.
3. Unit/contract and browser end-to-end results, including failure, consent, revision and recovery cases.
4. Keyboard, focus, contrast, screen reader, RTL/mixed-text and zoom/reflow verification.
5. Evidence from novice and experienced user testing; unresolved issues prioritized by user harm and frequency.
6. A parity statement proving that moving advanced controls did not remove functionality or alter data/permission semantics.
7. Explicit known limitations, deferred items, and any release blockers remaining under `docs/ACCEPTANCE_MATRIX.md`.

## 10. What not to build

- A dashboard in place of a story experience.
- A second, simplified backend or a separate “simple data model.”
- A large onboarding questionnaire, gamified tutorial, or mandatory tour before a first useful action.
- A wizard that adds steps without reducing decisions.
- A collection of nested accordions that hides a still-unusable form.
- AI that secretly creates facts, takes over the protagonist, or applies model proposals.
- Cloud-provider defaults that send data before meaningful consent.
- Unverified claims of live-model compatibility, AI quality, child suitability, or installed-desktop readiness.
- UI elements that appear implemented but have no working path.
- Aesthetic polish that damages readability, recovery, or functionality.
- Mass structural refactors unrelated to the documented UX outcomes.

## 11. Instructions for coding/design agents using this file

1. **Read first:** `README.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `AGENTS.md`, `docs/PROJECT_STATUS.md`, `docs/ACCEPTANCE_MATRIX.md`, the relevant `docs/contracts/*`, `docs/agents/WORKFLOW_GUIDE.md`, and narrative `guides/*` where story behavior is touched.
2. Inspect actual source, browser behavior, supported product states, and current tests before identifying a defect. **This file describes goals, not a finished runtime audit.**
3. For every UI change, state: primary user, problem, desired task outcome, current friction and its evidence, change proposed, affected contracts, advanced-path preservation, failure paths, and test plan.
4. Prefer removing unnecessary decisions from the default path over merely renaming a button or adding another collapsible panel.
5. Retain complete but appropriately placed advanced paths, searchable help, and contextual discoverability.
6. Keep domain rules enforced in the backend and avoid silent or irreversible behavior changes.
7. Deliver verified end-to-end slices; update source contracts, acceptance matrix, status and test coverage whenever behavior or UX expectations change.
8. Never mark runtime usability, accessibility, Windows packaging, provider behavior, or release readiness as verified from source inspection/build success alone.
9. Preserve unrelated user work and keep migration reversible where possible. Document what happened, validation, remaining uncertainties, and recovery implications.

## 12. Repo-specific baseline and references

### Inspected source baseline (2026-10-30)

- `README.md` and `PRODUCT.md` establish the local-first shared core, primary Story Studio workflow, review authority, no mandatory paid provider, and the principle that Simple and Advanced modes change controls rather than data meaning.
- `ARCHITECTURE.md`, `DECISIONS.md`, and `docs/contracts/*` establish the gateway, immutable world versions, branch isolation, provider/privacy contracts, deterministic mechanics and portable formats.
- `docs/PROJECT_STATUS.md` and `docs/ACCEPTANCE_MATRIX.md` report partial UX, browser, accessibility, provider and installed-Windows acceptance; these remain **unverified release gates**, not automatic passes.
- `frontend/src/App.tsx` contains four top-level page destinations; Knowledge exposes seven internal views; the global toolbar exposes a revision and search rebuild; Story includes libraries, a three-stage world editor, guided adventure setup, story transcript/composer, NPC/memory/mechanics/map and import/export controls. Several sections already use progressive disclosure.
- `frontend/src/App.tsx` is approximately 5,288 lines in the inspected version and contains a large concentration of interactive controls. Source counts do **not** establish how many are simultaneously visible or how the app behaves at runtime.
- `frontend/src/styles.css`, `frontend/src/workflow.css`, and `frontend/src/story-studio.css` contain extensive microtype and overlapping custom styles; these require **rendered** typography/accessibility validation.
- `guides/instructions.md` and `guides/style.md` define narrative agency, causality, voice, pace, continuity, and idiomatic Persian. UI changes must not undermine these story-quality requirements.
- Tests under `tests/browser-*.py`, `tests/unit/`, and `tests/README.md` provide an existing safety baseline, not proof of all usability outcomes.

### UX and accessibility references

These are **design references**, not substitutes for validation of Lorethra:

- UX Pilot — [12 Dashboard Design Principles For Better UX](https://uxpilot.ai/blogs/dashboard-design-principles): user task, visual priority, actionable information and reduced overload. Apply to dashboards selectively; Lorethra's story experience is not a BI dashboard.
- UXPin — [Dashboard Design Principles](https://www.uxpin.com/studio/blog/dashboard-design-principles/): purpose, clarity, purposeful hierarchy and understandable information presentation.
- Maze — [The 6 Key Principles of UI Design](https://maze.co/collections/ux-ui-design/ui-design-principles/): clarity, familiarity, control, hierarchy, flexibility and accessibility.
- Nielsen Norman Group — [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/): reveal specialist controls when needed.
- Nielsen Norman Group — [8 Design Guidelines for Complex Applications](https://www.nngroup.com/articles/complex-application-design/): reduce clutter without losing advanced capability.
- Nielsen Norman Group — [Supporting “Power Users” Isn’t Enough](https://www.nngroup.com/articles/complex-apps-users/): design for varied relationships between domain expertise and software familiarity.
- W3C — [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/): normative accessibility conformance criteria; distinguish official criteria from Lorethra's more ambitious design preferences.

---

## Final decision rule

> **If a feature makes the engine stronger but the default experience harder to understand, keep the feature and redesign its presentation.**
>
> If a simpler interface would bypass consent, validation, human review, provenance, deterministic rules, or recovery, reject that shortcut.
>
> **A new user should feel they are creating and living a world. An expert should feel the entire world engine is available when they ask for it.**
