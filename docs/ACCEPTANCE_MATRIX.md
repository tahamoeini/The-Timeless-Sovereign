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
| Temporal query | Future knowledge excluded from past/actor context | Not implemented |
| Character agency | User-controlled action is never invented or committed | Not implemented |
| Transcript deduplication | Same transcript imported twice adds no turns/events | Not implemented |
| Provider failure | Runtime failure leaves no partial canonical commit | Provider path not implemented |
| Local API boundary | Auth, origin, loopback, and sidecar token tests | Adapter added; tests pending |
| File ingestion safety | Size/type/path/archive limits and hostile fixtures | Not implemented |
| Graph/matrix consistency | All views reflect one canonical relation after edits | UI/projection worker not implemented |
| Backup/restore equivalence | Restore elsewhere matches sources, revisions, and official state | Not implemented; release blocker |
| Local-only path | Full core workflow without cloud or paid API | Core is local; complete workflow not implemented |
| Windows install | Clean-machine install without preinstalled Python | Not implemented; release blocker |

The currently runnable command is:

```powershell
python -m unittest discover -s tests\unit -v
```

The present suite has 10 passing core tests. This is not an end-to-end product acceptance run.

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
