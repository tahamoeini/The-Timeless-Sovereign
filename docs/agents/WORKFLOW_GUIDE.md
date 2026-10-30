# Agent workflow guide

This guide describes repository research, implementation, and evaluation practices. It is not an executable skill and does not grant scope or authority. Follow user authorization and AGENTS.md.

## Before a change

Read AGENTS.md, PRODUCT.md, ARCHITECTURE.md, DECISIONS.md, the relevant contracts, docs/PROJECT_STATUS.md, and docs/ACCEPTANCE_MATRIX.md. For competitor-derived work, read docs/agents/COMPETITOR_RESEARCH_LOG.md and verify that the source date and access boundary still apply.

Inspect current code before labeling a capability missing. Separate product intent, implemented source, executed validation, and external marketing claims. Update status, the relevant contract, and acceptance evidence when behavior changes.

## Research and specification

1. State the user outcome, affected workflow, scope, and constraints.
2. Read official product pages and technical documentation. For interactive products, inspect low-impact navigation and settings only; do not create accounts, paid generations, uploads, or lasting external test data without explicit authorization.
3. Record observed controls separately from advertised capabilities. Do not upload project data to external products.
4. For each opportunity, identify the existing foundation, precise gap, user benefit, source, confidence, cost, complexity, and architecture fit.
5. Specify the journey from entry through review, persistence, reopen, export, and recovery. Include cancellation, stale revisions, duplicates, invalid import, provider failure, and empty states.
6. Describe proposed ownership, commands, records, projections, permission checks, migrations, backups, and rollback. Keep proposals distinct from established contracts.
7. Define observable acceptance criteria and dependencies. Do not invent numeric targets or delivery estimates without evidence.

Evidence records should include an ID, source URL or repository path, inspection date, supported observation, whether it was advertised, observed, or tested, local counterpart, gap, uncertainty, and next proof.

## RPG implementation boundaries

Keep the ordinary path short: continue an adventure or create/import a world, prepare a protagonist, then play. Keep the transcript and composer central; make memory, map, NPC, and asset details contextual. Use a guided flow for multi-step world/hero/adventure setup and progressive disclosure for advanced rules. Do not make a user pass through Knowledge Explorer or edit raw JSON to start a story.

- SQLite rows are canonical. Search, graphs, manifests, summaries, and other derived data are projections.
- Every canonical write goes through the validated command gateway. UI components and providers never write canonical tables directly.
- World revisions are immutable. Each adventure pins a version and owns an isolated branch snapshot, conversation, and RPG state.
- Validate point-buy allocation against the pinned world version before branch creation. Keep attributes, trackers, exceptional abilities, skills, and experience as distinct concepts.
- Generate dice in the authenticated API and validate math against pinned rules in gateway code. Models may narrate recorded outcomes but cannot choose rolls or change arithmetic.
- Generated state and memory remain proposals until human review. Acceptance checks the expected revision and current source state.
- The optional World Architect uses local Ollama only. Its structured draft validates unique locations and the starting-place reference, stays unsaved, and can be canceled while generating. The user must preview and apply it before editing and saving a new world version through the command gateway. Never add remote-provider drafting without the matching consent, privacy, and capability design.
- A public opening-scene situation and hook are pinned to a world version and included only for the first generated response. Treat them as untrusted narrative data and never let them choose a user-controlled protagonist's actions.
- Apply workspace, branch, actor, review, visibility, and time permissions before ranking or summarizing context. Extend the existing compiler and manifest rather than creating a second canonical memory store.
- Treat packages, prompts, provider output, and imported story data as untrusted. Preview IDs, versions, provenance, paths, and privacy before import. Never execute imported formulas, scripts, HTML, or prompts.
- For MNO imports, preserve narrator, NPC, action, check, thought, and meta roles. Thoughts and meta remain author-only and out of future model context and reader output. NPC secrets and life records remain private; old check narration is not a verified die result. World-cast NPCs enter an adventure only after explicit selection; simulation stays off by default.
- Preserve audit history, idempotency, optimistic revision checks, branch isolation, and full backup/restore.

Current schema is v18. See docs/contracts/DATA_MODEL.md and docs/contracts/COMMAND_CONTRACTS.md for exact contracts. Code presence does not imply release readiness.

## Validation and evaluation

For each slice, cover the command boundary and authenticated API or browser boundary where behavior crosses the UI. Include success, invalid input, stale revision, idempotent replay, workspace/branch isolation, pending/rejected proposals, malformed imports, provider failure, cancellation, and recovery as applicable.

| Area | Required proof |
|---|---|
| Knowledge boundaries | Cross-workspace, branch, actor, future-time, and review-state exclusions, including derived context |
| Memory quality | Fixed-budget recall and precision against a chronological baseline; preserve contradictory sources |
| Canon review | Reject makes no canonical mutation; accept is audited and idempotent; stale source/revision fails safely |
| Narrative | Human rubric for agency, voice, Persian naturalness, pacing, and continuity over long sessions |
| World packages | Independent sessions, hostile/invalid inputs, version mismatch, identity collisions, round-trip and recovery |
| Media | Asset lineage, selective revision, offline fallback, cancellation, and a spend ceiling |
| Publishing | RTL and mixed-script review; private context excluded; preview matches the exported artifact |
| Recovery | Reopen and restore to a separate destination preserve canonical history, packages, and asset references |

For bilingual acceptance, include RTL layout, punctuation, mixed Persian/English, search, and the installed font. Record model/provider versions, hardware, fixture, source revision, latency, context size, results, and limitations. Set numeric targets only after collecting a baseline.

Read tests/README.md for core and browser procedures. A build is not browser acceptance; mocked providers are not live-model acceptance; a sidecar smoke is not clean-machine desktop acceptance.

## Completion report

Use docs/agents/HANDOFF_TEMPLATE.md. State what changed, why, evidence, validation, remaining uncertainty, recovery implications, and the next smallest action. Keep docs/PROJECT_STATUS.md, docs/ACCEPTANCE_MATRIX.md, and CHANGELOG.md consistent with the source. Do not claim a phase complete because it compiles.
