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
2. Apply deterministic actor, awareness-order, narrative-order, branch, review-status, and access filters. Actor contexts include only claims with an explicit, eligible belief record for that actor; a claim's general visibility alone never grants an NPC omniscience.
3. Retrieve exact IDs and aliases, then full-text matches; semantic and graph retrieval are optional projections.
4. Deduplicate while retaining distinct evidence and contradictory accounts.
5. Rank within token budget; record included and excluded candidates with reasons.
6. Emit evidence and a manifest. A provider response cannot alter this manifest.

## Output manifest

The `lke.context.v1` result records its ID, request, compiler version, workspace/branch/revision, provider scope, included record IDs, evidence IDs, provenance, epistemic/review labels, claim visibility, token estimate, exclusions, and unresolved conflicts. External-provider requests record their explicit privacy scope. Context built against a stale revision must be rejected or visibly recompiled.

NPC retrieval is actor- and time-scoped. A character does not receive a future fact, a fact the character has not explicitly encountered, author-only material, or another workspace's content. A retrieved absence is not evidence that a relation does not exist. The current implementation supports relative narrative order and explicit beliefs; valid-time intervals and richer event timelines remain pending. Story generation checks that the requested base revision matches the compiled manifest, then rechecks it when atomically saving both turns. A concurrent change therefore rejects the generated response instead of attaching it to stale context.

Each saved story turn retains the exact context manifest JSON and its manifest ID with the context revision, so a later review can inspect what was included and excluded. External story and memory requests require a matching provider-consent value at the authenticated API. Before sending, the API filters non-public claims, private author/character material, actor-scoped facts, unshared or unreviewed memories, and unclassified world lore or threads. This is an additional privacy boundary; it does not prove a provider's retention or post-cancellation behavior. The compiler and manifest format are specified here; semantic retrieval and token accounting are not implemented yet.

## Temporal character-memory query

`POST /api/v1/workspaces/{workspace_id}/temporal-query` answers a question about one actor's memory at a relative narrative order. The request names the workspace path, branch, actor, expected revision, order, optional local Ollama model, and question. A model is required only when eligible claims exist. This is narrative-order character memory; calendar-date questions over Journal events and richer valid-time timelines remain pending.

The route compiles the same revision-bound actor context used by Story Studio. Only included claims are sent to the local model; excluded claim content and exclusion records are not provider input. The model must return an answer status and claim IDs, and the API accepts an answer only when it cites one or more claim IDs from that exact included set. Citation records retain epistemic status, actor stance, narrative and awareness order, and evidence IDs. `unknown`, `believed`, and `contested` claims must remain qualified rather than being stated as settled truth. Unsupported answers and out-of-manifest citations become a deterministic insufficient-memory response.

The route is read-only. It rejects a stale expected revision before calling the model and checks the branch revision again after the model responds; if the branch changed during generation, it returns a conflict and discards the answer. If no eligible claims exist, it returns the deterministic insufficient-memory response without calling the model. This guards against temporal leakage from canonical facts that the actor cannot yet know; it does not guarantee the semantic correctness of a local model's prose when it cites eligible claims.
