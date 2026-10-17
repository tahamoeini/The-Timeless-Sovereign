# Documentation map

The product and architecture baselines live in the root documents. Detailed contract documents are created with the implementation and checks that enforce them, to avoid design documents claiming unimplemented behavior.

Required v0.1 documents from the plan:

| Document | Required content | Status |
| --- | --- | --- |
| PRODUCT.md | Goals, users, journeys, scope | Baseline written |
| ARCHITECTURE.md | Module boundaries, ownership, data flow | Baseline written |
| DATA_MODEL.md | Schemas, identity, time, belief, branch | To define with canonical-core implementation |
| COMMAND_CONTRACTS.md | Commands, invariants, authorization, revisions | To define with command-gateway implementation |
| AI_PROVIDER_SPEC.md | Adapters, capabilities, model constraints | To define with AI gateway |
| CONTEXT_PROTOCOL.md | Retrieval, manifest, context package | To define with context compiler |
| EXCHANGE_PROTOCOL.md | Context, transcript, deltas, deduplication | To define with bridge |
| NARRATIVE_RULES.md | Character control, world rules, NPC cycle | To define with Story Studio |
| INTEGRATION_REGISTER.md | Reuse and framework evaluation | To populate from repository inspection and benchmarks |
| ACCEPTANCE_MATRIX.md | End-to-end, negative, failure, regression evidence | To maintain with acceptance coverage |
| OPERATIONS.md | Installation, backup, restore, troubleshooting | To verify with packaged builds |
| DECISIONS.md | Architecture decisions and rationale | Baseline written |

Tests and benchmarks are evidence; this map is not a claim that any acceptance item has passed.
