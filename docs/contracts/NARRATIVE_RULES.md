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

The current Story Studio stores user prompts and assistant prose as revisioned conversation turns. It compiles only reviewed, actor-aware knowledge at a selected narrative order and records the context manifest and base revision used for generation. A branch snapshot copies its conversation history; subsequent turns stay branch-local.

The user can mark the viewpoint character as user-controlled. That constraint is passed to the provider prompt, and generated prose never changes canonical claims, relations, events, or character knowledge. The control instruction is tested with a simulated provider, but model compliance has not been red-teamed or verified against a live model. Scene state, NPC goal evaluation, event proposals, and reviewed state deltas are not implemented yet.
