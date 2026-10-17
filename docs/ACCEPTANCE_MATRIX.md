# Acceptance Matrix

The release gates are measurable behaviors, not claims that a test name exists. Status is updated only after the specified test is executed against the current implementation.

| Requirement | Required evidence | Current status |
|---|---|---|
| Workspace isolation | Cross-workspace query and foreign reference tests | Core unit test passes |
| Branch isolation | Snapshot, branch write, and unchanged main branch | Core unit test passes |
| Scenario comparison | Show branch-only records and review changes against the current parent | Browser verifies a scenario-only concept is reported against its parent; branch-local rule evaluation is available; option assumptions, outcome scoring, and historical-parent comparison are pending |
| Rule evaluation | Hard/soft require/forbid constraints evaluate to satisfied, violated, or unknown without treating missing, private, uncertain, or unreviewed claims as false | Core evaluator and branch-isolation tests pass; Scenario Lab rule form and result view build; authenticated API and interactive browser verification are pending; compound rules and option overlays are not implemented |
| Optimistic concurrency | Stale write rejected with no partial rows | Core unit test passes |
| Idempotency | Retry gives same result; key reuse with changed request conflicts | Core unit tests pass |
| Atomic audit/outbox | Successful write creates one revision, audit event, outbox item | Core unit test passes |
| Append-only audit | Direct update/delete attempts fail | Core unit test passes |
| Source deduplication | Repeat content creates no second source/revision | Core unit test passes |
| Evidence grounding | Quote must exist in immutable source text | Core unit test passes |
| Canon integrity | AI proposal cannot mark claim/relation accepted | Core unit test passes for claims/relations |
| Manual override | Reprocessing preserves reviewed override | Not implemented |
| Temporal query | Relative narrative order and awareness exclude future or unknown facts | Core unit tests cover actor awareness and date-window overlap for exact/ranged journal accounts; relative or unknown timing is excluded instead of guessed; temporal question answering is pending |
| Character agency | User-controlled action is never invented or committed | User-control guard is sent in generation prompt and no story output writes canon; simulated-provider check passes, live-model compliance not verified |
| Transcript deduplication | Same transcript imported twice adds no turns/events | Not implemented |
| Provider failure | Runtime failure leaves no partial canonical commit | Simulated-provider failure returns 503 with no saved turn or revision change; live Ollama outage behavior remains unverified |
| Story persistence | Create, close/reload, and continue a branch-scoped conversation | Schema v4 migration, atomic turn storage, retry, and branch snapshot tests pass; browser creation, branch selection, and reload persistence verified; local generation remains blocked until Ollama is running |
| Journal note access | List saved notes and open their original source text without crossing workspaces | Source detail and workspace-scope unit test passes; UI compiles; browser verification of the new Journal view and API route is pending |
| Journal event history | Record exact, ranged, relative, or unknown timing with optional source quotes; filter by date without guessing; correct an account without erasing its previous version; isolate edits by branch | Gateway tests cover date validation and overlap, exclusion of uncertain timing, exact source quote, conflicting accounts, append-only corrections, stale-version rejection, and branch isolation; UI build passes; interactive browser and API boundary verification remain pending |
| Context export | Save a portable package with actor, branch, revision, included facts, and exclusions | Browser verifies the downloaded JSON envelope, context manifest, branch/revision provenance, included/excluded fields, and omission of source full text; external sharing and redaction remain user-controlled and unimplemented |
| Local API boundary | Auth, origin, loopback, and sidecar token tests | Auth, allowed-origin, preflight, API round-trip tests, and standalone sidecar health/token smoke test passed before the journal and rule changes; current source-detail, journal-event, and rule-evaluation HTTP assertions remain unverified |
| User workflows | Create workspace, add concepts, review claims/links, preview actor context, branch scenario, and reopen a saved story | Browser flow verified for workspace, entities, relations, UTF-8 text source import and full-text search, evidence-backed claim review, actor awareness, branch isolation, and saved story reload; live story generation not verified |
| Windows desktop package | Tauri shell and bundled backend start/stop on a clean machine | Standalone sidecar built and smoke-tested; Tauri shell build blocked by missing MSVC linker; installer not built |
| File ingestion safety | Size/type/path/archive limits and hostile fixtures | Text/Markdown path is limited to 10 MiB, requires UTF-8 in the UI, and is rechecked by the command gateway for media type, empty content, binary NUL bytes, and size; browser verification confirms a local `.txt` import, revision advance, and searchable excerpt; no source path or archive extraction is accepted; hostile file-picker and Unicode fixtures remain pending |
| Graph/matrix/history consistency | Views reflect the selected branch's canonical relations and revisions | Browser verifies the concept map and matrix show the same directed relationship on a scenario branch and history lists that branch's revisions; automated cross-view edit parity is pending |
| Backup/restore equivalence | Restore elsewhere matches sources, revisions, and official state | Manifest, integrity, FTS, source, revision, and schema-v4 migration tests pass; separate-device drill pending |
| Local-only path | Full core workflow without cloud or paid API | No cloud dependency in current core/story path; end-to-end model workflow needs a live local Ollama model |
| Windows install | Clean-machine install without preinstalled Python | Not implemented; release blocker |

The currently runnable core and API test command is:

```powershell
python -m unittest discover -s tests\unit -v
```

The present suite has 43 tests. The latest run passed all 36 command-gateway, backup/restore, migration, Ollama adapter, and rule-evaluator tests. The 7 API-boundary tests passed in an earlier full run, but could not be rerun with the current bundled Windows Python because its asyncio event-loop setup blocks while creating a local loopback socket pair in this sandbox; source-detail, journal-event, and rule-evaluation HTTP assertions are therefore unverified. Journal-event and rule-evaluation route handlers were checked directly, but that does not replace an authenticated HTTP test. Browser verification also remains pending because this sandbox denies local loopback access. Repeat the API and browser checks in an environment with working local loopback access before release. Passing unit tests do not substitute for live-model, clean-machine, or full release acceptance runs.

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
