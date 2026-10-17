# Context Protocol

Every generation request uses a versioned context request. Retrieval is a read-only projection over one explicitly authorized workspace and branch.

## Request

```json
{
  "protocol": "lke.context.v1",
  "request_id": "ctxreq_001",
  "workspace_id": "workspace_001",
  "branch_id": "main",
  "base_revision": 42,
  "purpose": "continue_scene",
  "domain_time": {"kind": "relative", "value": "night after the oath"},
  "actor_id": "aria",
  "access_scope": ["accepted_claims", "character_memory", "world_rules"],
  "token_budget": 6000,
  "provider_capability": "chat"
}
```

## Compilation order

1. Verify workspace, branch, current revision, and authorization.
2. Apply deterministic actor, time, branch, review-status, and access filters.
3. Retrieve exact IDs and aliases, then full-text matches; semantic and graph retrieval are optional projections.
4. Deduplicate while retaining distinct evidence and contradictory accounts.
5. Rank within token budget; record included and excluded candidates with reasons.
6. Emit evidence and a manifest. A provider response cannot alter this manifest.

## Output manifest

The `lke.context.v1` result records its ID, request, compiler version, workspace/branch/revision, provider scope, included record IDs, evidence IDs, provenance, epistemic/review labels, token estimate, exclusions, and unresolved conflicts. Context built against a stale revision must be rejected or visibly recompiled.

NPC retrieval is actor- and time-scoped. A character does not receive omniscient world knowledge, a future fact, or another workspace's content. A retrieved absence is not evidence that a relation does not exist.

The compiler and manifest format are specified here; semantic retrieval and token accounting are not implemented yet.
