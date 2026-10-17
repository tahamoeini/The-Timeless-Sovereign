# Acceptance Matrix

The release gates are measurable behaviors, not claims that a test name exists. Status is updated only after the specified test is executed against the current implementation.

| Requirement | Required evidence | Current status |
|---|---|---|
| Workspace isolation | Cross-workspace query and foreign reference tests | Core unit test passes |
| Branch isolation | Snapshot, branch write, and unchanged main branch | Core unit test passes |
| Optimistic concurrency | Stale write rejected with no partial rows | Core unit test passes |
| Idempotency | Retry gives same result; key reuse with changed request conflicts | Core unit tests pass |
| Atomic audit/outbox | Successful write creates one revision, audit event, outbox item | Core unit test passes |
| Append-only audit | Direct update/delete attempts fail | Core unit test passes |
| Source deduplication | Repeat content creates no second source/revision | Core unit test passes |
| Evidence grounding | Quote must exist in immutable source text | Core unit test passes |
| Canon integrity | AI proposal cannot mark claim/relation accepted | Core unit test passes for claims/relations |
| Manual override | Reprocessing preserves reviewed override | Not implemented |
| Temporal query | Relative narrative order and awareness exclude future or unknown facts | Core unit test passes; richer valid-time ranges pending |
| Character agency | User-controlled action is never invented or committed | User-control guard is sent in generation prompt and no story output writes canon; simulated-provider check passes, live-model compliance not verified |
| Transcript deduplication | Same transcript imported twice adds no turns/events | Not implemented |
| Provider failure | Runtime failure leaves no partial canonical commit | Simulated-provider failure returns 503 with no saved turn or revision change; live Ollama outage behavior remains unverified |
| Story persistence | Create, close/reload, and continue a branch-scoped conversation | Schema v2 migration, atomic turn storage, retry, and branch snapshot tests pass; browser creation, branch selection, and reload persistence verified; local generation remains blocked until Ollama is running |
| Context export | Save a portable package with actor, branch, revision, included facts, and exclusions | Browser verifies the downloaded JSON envelope, context manifest, branch/revision provenance, included/excluded fields, and omission of source full text; external sharing and redaction remain user-controlled and unimplemented |
| Local API boundary | Auth, origin, loopback, and sidecar token tests | Auth, allowed-origin, preflight, API round-trip tests, and standalone sidecar health/token smoke test pass |
| User workflows | Create workspace, add concepts, review claims/links, preview actor context, branch scenario, and reopen a saved story | Browser flow verified for workspace, entities, relations, source search, evidence-backed claim review, actor awareness, branch isolation, and saved story reload; live story generation not verified |
| Windows desktop package | Tauri shell and bundled backend start/stop on a clean machine | Standalone sidecar built and smoke-tested; Tauri shell build blocked by missing MSVC linker; installer not built |
| File ingestion safety | Size/type/path/archive limits and hostile fixtures | Not implemented |
| Graph/matrix/history consistency | Views reflect the selected branch's canonical relations and revisions | Browser verifies the concept map and matrix show the same directed relationship on a scenario branch and history lists that branch's revisions; automated cross-view edit parity is pending |
| Backup/restore equivalence | Restore elsewhere matches sources, revisions, and official state | Manifest, integrity, FTS, source, revision, and schema-v2 migration tests pass; separate-device drill pending |
| Local-only path | Full core workflow without cloud or paid API | No cloud dependency in current core/story path; end-to-end model workflow needs a live local Ollama model |
| Windows install | Clean-machine install without preinstalled Python | Not implemented; release blocker |

The currently runnable core and API test command is:

```powershell
python -m unittest discover -s tests\unit -v
```

The present suite has 27 passing core, API boundary, backup/restore, migration, and Ollama adapter tests. These do not substitute for live-model, clean-machine, or full release acceptance runs.

## Quality targets

Entity F1, relation precision, evidence grounding, retrieval Recall@K, temporal accuracy, context efficiency, narrative continuity, human review cost, import performance, and recovery performance require a fixed bilingual evaluation corpus and rubric. Numeric targets are intentionally unset until a measured baseline exists.

## Definition of Done

- [ ] Windows app installs and launches from a clean machine.
- [ ] Main user workflow is available without a paid API.
- [ ] Files, conversations, and evidence persist across restarts.
- [ ] Graph, matrix, and history share one canonical data source.
- [ ] Relationship edits and approvals appear consistently in every view.
- [ ] Story, characters, and memory persist across turns.
- [ ] Scenario branches cannot alter the primary branch.
- [ ] Provider and model can be changed.
- [ ] AI proposals cannot enter official state without authorization.
- [ ] Full backup and restore is verified on a different location.
- [ ] Core integration and security gates pass.
- [ ] Code, license, documentation, and public build instructions are release-ready.
