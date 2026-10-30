# Narrative and Character Rules

Narrative generation can propose text and state deltas; it does not decide user-controlled actions or commit canonical state.

## Character frame

An actor context includes goals, motivations, beliefs, memories, relationships, constraints, current state, and allowed actions. Each item is scoped by source, branch, time, confidence, and actor awareness where applicable. Contradictions remain visible.

## Scene frame

A scene records domain time, location, present actors, opening state, transcript turns, proposed events, and proposed state changes. Narrative order is distinct from calendar time.

## Turn cycle

`Observe → Evaluate Goals → Propose Action → Check Rules → Narrate Outcome → Review State Delta`

Hard constraints include world rules, actor knowledge boundaries, and user control of their own character. Soft constraints include voice, pacing, and descriptive density. Creative freedom applies only to unspecified details and may not silently create consequential canonical facts.

The user controls their character's speech, intent, and consequential decisions unless they explicitly delegate a bounded action. NPC actions must follow their goals and available knowledge. No continuous unattended time advance is the default. All generated claims, relationships, and events stay proposed until reviewed and committed.

## Consistency and causality

Rule evaluation distinguishes satisfied, violated, and unknown preconditions. A scenario generator labels assumptions and alternatives. A consistency checker reports conflicts in time, knowledge, resources, and rules. Correlation or sequence alone is not presented as causality. Decision outputs are conditional analyses, not guaranteed forecasts.

The current Story Studio stores user prompts and assistant prose as revisioned conversation turns. It compiles only reviewed, actor-aware knowledge at a selected narrative order and records the context manifest and base revision used for generation. RPG adventures add the pinned world's public description and lore, the approved protagonist sheet, recent deterministic checks, the current branch actor's optional identity notes, and eligible MNO lorebook entries to that context. Setup edits the reusable main-branch character; the active-adventure panel edits that adventure's actor snapshot only. Identity notes cover concept, background, personality, current goal, and voice; they are user-authored descriptive guidance, not instructions that can override world rules or user control. A historical retry retains the profile snapshot recorded in the original turn context. Hosted-provider filtering removes the profile and imported lorebook reference before an outbound request. MNO lorebook activation settings are pinned to immutable world versions; selected entries appear in the saved turn manifest with their selection reason, while excluded counts remain inspectable. Lorebook text is narrator reference, not evidence of character knowledge or canon. A world version may also pin an optional public opening scene with a situation and immediate hook; it is included only while generating the first response, treated as untrusted story data, and never authorizes actions for a user-controlled character. Private author notes, pending or rejected state proposals, and unreviewed state changes are excluded. A branch snapshot copies its conversation history and RPG state; subsequent turns and state changes stay branch-local.

An adventure NPC may include an optional `relationship_to_actor` note (at most 500 characters) in its public profile. It describes the NPC's current stance toward the protagonist for narrator guidance; it is not proof the protagonist knows that stance. Opt-in NPC simulation may propose a change only when the recent story supports one. The normal RPG proposal review command must accept it before the profile changes. The proposal is tied to its source turn, so editing/removing that turn invalidates the proposal during supported historical reconstruction. It remains local to the selected adventure branch and follows adventure package export/import rules.

The user can mark the viewpoint character as user-controlled. That constraint is passed to the provider prompt, and generated prose never changes canonical claims, relations, events, or character knowledge. The control instruction is tested with a simulated provider, but model compliance has not been red-teamed or verified against a live model. RPG dice are generated locally and the gateway calculates outcomes from pinned rules; the model cannot choose the roll or result. A human can review tracker and location proposals, with sheet revision checks before acceptance. Full scene state, NPC goal evaluation, memories and summaries, maps and travel, and event proposals remain unimplemented.

For a world version with an explicit non-narrative mechanics profile, the provider may request a check only for a meaningful uncertain action. The private request contains a pinned encounter type, difficulty, and stat or skill; the model must not choose dice or an outcome. In the same response it supplies concise success and failure narration. Lorethra generates dice locally, and the gateway validates the request and computes the result from that adventure's pinned rules and current sheet. The gateway then writes only the matching narrative with the check, in one revision and transaction. This keeps the story consequence immediate without a second provider call. Invalid protocol or rule IDs fail before any turn is committed.

World versions created with the current defaults and imported MNO worlds enable this flow. Existing worlds without an explicit mechanics profile retain their prior manual-check behavior, and narrative-only worlds never roll. Automatic XP is a derived total based on completed player turns and the pinned cap; new worlds and MNO imports default to one XP per completed turn with manual awards disabled. Edits to a pinned world version do not change active adventures. Check records point to their assistant turn, so checks from later hidden or superseded turns are excluded from current context while older historical snapshots and portable archives retain their provenance. Automatic outcome selection does not auto-accept tracker, location, memory, inventory, quest, or other state proposals.
