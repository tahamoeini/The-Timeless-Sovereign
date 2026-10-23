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

`create_entity`, `update_entity`, `add_relation`, `review_relation`, `add_claim`, `review_claim`, `add_belief`, `import_source`, `add_evidence`, `create_conversation`, `append_story_turn`, `create_journal_event`, `revise_journal_event`, `create_rule`, `review_rule`, `create_scenario`, `set_scenario_assumption`, `review_scenario_assumption`, `record_extraction_batch`, and `review_extraction_candidate` are implemented in schema v6. `create_branch` creates a revision-bound snapshot of canonical records, story history, rules, journal-event versions, scenario options, evidence links, assumption versions, and extraction batches/candidates with its own audit/outbox record.

The `/sources/{source_id}/extract` route sends a selected local model a bounded text source and records schema-validated entity/claim candidates through `record_extraction_batch`. Each candidate must include a quote matching its exact source span. The batch records source digest and model/prompt/schema versions; idempotent retries replay the saved batch without rerunning the model. `review_extraction_candidate` can reject a candidate or accept an entity/claim with its exact source evidence in one transaction. Accepting a claim requires a user-selected subject entity, epistemic status, and visibility. Candidate payloads are immutable, and AI actors cannot review them.

`append_story_turn` writes the user's prompt and local-model response in one command, recording provider, model, narrative order, context manifest, and context revision. Generated text is conversation history, not an accepted fact or state change. Its retry fingerprint excludes nondeterministic model output and the per-request manifest ID while binding the workspace, branch, prompt, model, order, and expected revision.

`create_journal_event` records a user-provided account with participants, exact/range/relative/unknown timing, and optional workspace source plus an exact quote. It does not assert that the account is verified. `revise_journal_event` requires the current event version and appends a correction; it cannot overwrite earlier wording. Separate event IDs remain separate when accounts conflict. AI actors cannot create or revise personal accounts.

`create_rule` records a proposed require/forbid condition on one entity, predicate, and value; `review_rule` is required before evaluation is active. The deterministic evaluator uses accepted public claims marked `known`. Unknown or private data never proves a rule, and conflicting values for an explicitly single-valued predicate return unknown. AI actors cannot accept rules. Rule evaluations are read-only projections and do not mutate canonical state.

`create_scenario` records a decision problem, constraints, two or three named options, and links to branch claims or workspace sources. `set_scenario_assumption` creates or revises an append-only assumption version for one option. Revisions require the latest assumption version; AI-originated assumptions remain proposed until a user reviews them. `replace` is valid only for a declared single-valued property, while `add` is valid only for a multi-valued property. `review_scenario_assumption` appends an accepted or rejected version and rejects stale reviews. The scenario evaluation read model applies accepted assumptions only to their option, reports deterministic rule outcomes as conditional, and preserves separate claim and assumption references. It never writes assumptions into canonical claims or predicts or scores outcomes.

Delete, merge, promotion, generalized domain-event/state, approval, and reviewed story-state-delta commands are not implemented yet.

## Failure behavior

Malformed payload: validation error, no write. Missing scoped record: not found, no write. Stale revision or duplicate identity: conflict, no write. Provider failure: no command is submitted unless a proposal exists; no partial canonical commit. Database failure before commit: rollback. Retrying a committed request with the original key: replay its original result.
