# Command Contracts

Canonical writes are submitted to the gateway; direct writes from models, projections, importers, or UI components are prohibited.

## Envelope

```json
{
  "workspace_id": "workspace_001",
  "branch_id": "main",
  "command_type": "create_entity",
  "expected_revision": 4,
  "idempotency_key": "request-unique-id",
  "actor": "user",
  "reason": "Add a character from reviewed source material",
  "payload": {"entity_id": "aria", "entity_type": "character", "label": "Aria", "properties": {}}
}
```

## Invariants

1. Validate workspace and branch existence and scope before mutation.
2. Reject stale `expected_revision`; never silently rebase a command.
3. The same idempotency key and same envelope returns its recorded result without a second write. Reuse with different input is a conflict.
4. Validate references inside the same workspace and branch. Relations and claims cannot point to records in another scope.
5. AI actors may propose claims, relations, rules, scenario assumptions, and extraction candidates but cannot accept or review them. They cannot create a scenario frame directly.
6. Evidence quotes must match the preserved source content.
7. A successful mutation increments the branch head once and writes the domain row, revision, audit event, projection outbox item, and idempotency result in one transaction.
8. Duplicate source content is a no-op and does not create a second source or revision.
9. Audit events are append-only. Real personal-data deletion needs a separate documented privacy operation; it cannot be implemented by rewriting audit history.
10. Derived projections can be rebuilt from canonical content and recorded commands.

## Implemented command set

`create_entity`, `update_entity`, `add_relation`, `update_relation`, `review_relation`, `add_claim`, `update_claim`, `review_claim`, `add_belief`, `import_source`, `add_evidence`, `create_conversation`, `append_story_turn`, `create_story_world`, `revise_story_world`, `create_story_adventure`, `update_rpg_sheet`, `record_d20_check`, `propose_rpg_state`, `review_rpg_state_proposal`, `create_journal_event`, `revise_journal_event`, `create_rule`, `review_rule`, `create_scenario`, `set_scenario_assumption`, `review_scenario_assumption`, `record_extraction_batch`, `review_extraction_candidate`, `import_exchange`, and `promote_branch` are implemented on schema v10. `import_exchange` stores an immutable branch-local transcript segment, detects gaps across turn 1 through the latest declared transcript total, rejects conflicting overlaps within its stable transcript ID, and does not write story turns or canonical facts. `create_branch` creates a revision-bound snapshot of canonical records, story history, adventures and their RPG state, external exchanges, rules, journal-event versions, scenario options, evidence links, assumption versions, and extraction batches/candidates with its own audit/outbox record.

The `/sources/{source_id}/extract` route sends a selected local model a bounded text source and records schema-validated entity/claim candidates through `record_extraction_batch`. Each candidate must include a quote matching its exact source span. The batch records source digest and model/prompt/schema versions; idempotent retries replay the saved batch without rerunning the model. `review_extraction_candidate` can reject a candidate or accept an entity/claim with its exact source evidence in one transaction. Accepting a claim requires a user-selected subject entity, epistemic status, and visibility. Candidate payloads are immutable, and AI actors cannot review them.

`update_entity`, `update_relation`, and `update_claim` provide human corrections to records in the selected branch. They return before/after values in the audit result and revision history; AI actors cannot execute them. Entity corrections preserve the stable entity ID. Correcting a reviewed relationship or claim returns it to proposed status so the changed record must be reviewed again. Claim evidence can be replaced only with evidence records present in that same workspace branch. An unchanged correction creates no new revision.

Re-running extraction records new proposed candidates and does not overwrite an accepted or manually corrected canonical claim. Independently accepted duplicate claims across batches are not deduplicated yet.

`append_story_turn` writes the user's prompt and local-model response in one command, recording provider, model, narrative order, context manifest, and context revision. Generated text is conversation history, not an accepted fact or state change. Its retry fingerprint excludes nondeterministic model output and the per-request manifest ID while binding the workspace, branch, prompt, model, order, and expected revision.

`create_story_world` creates the first workspace world version on `main`; `revise_story_world` appends a new immutable version after an expected-version check. World content is size-bounded JSON and rejects secret-like field names. Neither command can be executed by an AI actor. `create_story_adventure` is allowed only in a new direct-child snapshot of `main`, requires a character from that snapshot, pins an existing world version, and initializes its character sheet from the pinned template. World changes do not propagate to existing adventures. The authenticated API exposes world and adventure libraries, version creation, adventure start/resume, RPG state, and d20 check routes.

`update_rpg_sheet` lets the user adjust bounded stat modifiers and trackers or the adventure's current location. `record_d20_check` stores a die result from 1 to 20 and calculates `total = die_roll + current stat modifier` and success against the supplied visible target; the provider does not calculate or change this result. AI actors cannot roll checks or edit sheets. `propose_rpg_state` records a proposed tracker delta or location change, optionally linked to an assistant turn; a proposal is not part of the model context or canonical sheet while pending. `review_rpg_state_proposal` is human-only. Acceptance validates tracker limits and rejects stale branch revisions or proposals whose sheet changed after creation. Rejection records the decision without changing the sheet. Both decisions and all sheet/check writes use the normal revision, audit, outbox, and idempotency transaction.

`create_journal_event` records a user-provided account with participants, exact/range/relative/unknown timing, and optional workspace source plus an exact quote. It does not assert that the account is verified. `revise_journal_event` requires the current event version and appends a correction; it cannot overwrite earlier wording. Separate event IDs remain separate when accounts conflict. AI actors cannot create or revise personal accounts.

`create_rule` records a proposed require/forbid condition on one entity, predicate, and value; `review_rule` is required before evaluation is active. The deterministic evaluator uses accepted public claims marked `known`. Unknown or private data never proves a rule, and conflicting values for an explicitly single-valued predicate return unknown. AI actors cannot accept rules. Rule evaluations are read-only projections and do not mutate canonical state.

`create_scenario` records a decision problem, constraints, two or three named options, and links to branch claims or workspace sources. `set_scenario_assumption` creates or revises an append-only assumption version for one option. Revisions require the latest assumption version; AI-originated assumptions remain proposed until a user reviews them. `replace` is valid only for a declared single-valued property, while `add` is valid only for a multi-valued property. `review_scenario_assumption` appends an accepted or rejected version and rejects stale reviews. The scenario evaluation read model applies accepted assumptions only to their option, reports deterministic rule outcomes as conditional, and preserves separate claim and assumption references. It never writes assumptions into canonical claims or predicts or scores outcomes.

`promote_branch` is an explicit fast-forward from a direct child into its parent. The request names the exact source head revision and uses the parent's current expected revision. Promotion is allowed only when the parent still equals the child's recorded starting revision and the child contains changes. AI actors cannot promote. The gateway copies the branch-scoped canonical snapshot in dependency order, remaps child-created or updated revision markers to the single parent promotion revision, rebuilds the parent entity-search projection, and writes one parent revision, audit event, outbox item, and idempotency result in the same transaction. Immutable journal, scenario, evidence, and extraction history is inserted without rewriting existing parent history. The child and its revision history remain intact; the audit payload identifies the source branch and promoted revision range. There is no automatic conflict merge.

`import_story_world` validates a bounded `lke.world.v1` package, requires a new world ID, and atomically copies its contiguous version sequence into the main-branch library. The audit command records the package and source workspace/world IDs; imported versions receive the destination revision. The export and preview endpoints are read-only. Packages contain world content, which may include private notes; they do not export provider settings, but arbitrary user-authored text should be reviewed before sharing. World replacement and adventure packages are not implemented.

Every committed adventure turn and every edit or retry of an assistant scene creates a sourced, actor-scoped event-memory proposal in the same command transaction. The proposal contains a bounded scene excerpt and requires human review; it never becomes canon automatically. Editing or removing the source turn makes its pending review stale and retrieval excludes its accepted record until a revised proposal is reviewed. This is a sourced excerpt workflow, not semantic event extraction.

Story-turn edits, other memory lifecycle actions, NPC profiles, map locations, travel, local image attachments, and opt-in NPC simulation also have gateway commands. Historical state reconstruction after edits, generalized merge, richer event/scene deltas, and full publishing workflows remain incomplete; consult the acceptance matrix for current evidence.

## Failure behavior

Malformed payload: validation error, no write. Missing scoped record: not found, no write. Stale revision or duplicate identity: conflict, no write. Provider failure: no command is submitted unless a proposal exists; no partial canonical commit. Database failure before commit: rollback. Retrying a committed request with the original key: replay its original result.
