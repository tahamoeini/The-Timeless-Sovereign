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
5. AI actors may propose claims and relations but cannot set their review status to accepted.
6. Evidence quotes must match the preserved source content.
7. A successful mutation increments the branch head once and writes the domain row, revision, audit event, projection outbox item, and idempotency result in one transaction.
8. Duplicate source content is a no-op and does not create a second source or revision.
9. Audit events are append-only. Real personal-data deletion needs a separate documented privacy operation; it cannot be implemented by rewriting audit history.
10. Derived projections can be rebuilt from canonical content and recorded commands.

## Implemented command set

`create_entity`, `update_entity`, `add_relation`, `review_relation`, `add_claim`, `review_claim`, `add_belief`, `import_source`, `add_evidence`, `create_conversation`, and `append_story_turn` are implemented in schema v2. `create_branch` creates a revision-bound snapshot of canonical records and story history with its own audit/outbox record.

`append_story_turn` writes the user's prompt and local-model response in one command, recording provider, model, narrative order, context manifest, and context revision. Generated text is conversation history, not an accepted fact or state change. Its retry fingerprint excludes nondeterministic model output and the per-request manifest ID while binding the workspace, branch, prompt, model, order, and expected revision.

Delete, merge, promotion, event, approval, and reviewed story-state-delta commands are not implemented yet.

## Failure behavior

Malformed payload: validation error, no write. Missing scoped record: not found, no write. Stale revision or duplicate identity: conflict, no write. Provider failure: no command is submitted unless a proposal exists; no partial canonical commit. Database failure before commit: rollback. Retrying a committed request with the original key: replay its original result.
