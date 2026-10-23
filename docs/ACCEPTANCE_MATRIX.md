# Acceptance Matrix

The release gates are measurable behaviors, not claims that a test name exists. Status is updated only after the specified test is executed against the current implementation.

| Requirement | Required evidence | Current status |
|---|---|---|
| Workspace isolation | Cross-workspace query and foreign reference tests; rapid workspace/branch switching never displays or submits stale selected records | Core unit test passes; UI resets scoped forms, rejects obsolete shared-data and story-selection responses, and gates views until matching scope data loads; interactive switching and load-failure/retry verification remain pending |
| Branch isolation and promotion | Snapshot and isolate branch writes; review the full branch command history; explicitly promote a changed child into an unchanged direct parent; stale, nested, AI, and partial-copy cases fail safely | Core tests cover snapshot promotion across entities, relations, claims, evidence, story, journal, rules, assumptions, and extraction review; audit/outbox/idempotency and rollback pass; Scenario Lab builds with review acknowledgement and exact-parent gating; authenticated API and interactive browser verification remain pending |
| Scenario comparison | Record a decision, constraints, two or three options, related evidence, and separate option assumptions; compare deterministic outcomes without changing baseline facts | Core tests cover creation, evidence scope, append-only assumption changes, conditional rule results, human review of AI assumptions, and branch isolation; branch command history and record field comparisons are implemented; authenticated API and interactive browser verification remain pending; model advice is not implemented |
| Rule evaluation | Hard/soft require/forbid constraints evaluate to satisfied, violated, or unknown without treating missing, private, uncertain, or unreviewed claims as false | Core evaluator and option-overlay tests pass; Scenario Lab rule and outcome views build; authenticated API and interactive browser verification remain pending; compound rules and outcome scoring are not implemented |
| Optimistic concurrency | Stale write rejected with no partial rows | Core unit test passes |
| Idempotency | Retry gives same result; key reuse with changed request conflicts | Core unit tests pass |
| Atomic audit/outbox | Successful write creates one revision, audit event, outbox item | Core unit test passes |
| Append-only audit | Direct update/delete attempts fail | Core unit test passes |
| Source deduplication | Repeat content creates no second source/revision | Core unit test passes |
| Evidence grounding | Quote must exist in immutable source text | Core unit test passes |
| Review and correct canonical records | Edit entity type, label, and properties; correct relationship endpoints and claims; preserve branch scope and stable IDs; record before/after in revision history; require renewed review after changing an accepted/rejected claim or relationship | Gateway tests cover entity search refresh, auditable before/after, no-op writes, AI rejection, branch-local relationship edits, and claim evidence preservation; authenticated API and interactive browser verification pending |
| Model-assisted extraction | Run local extraction on a saved source; validate schema and exact quote spans; persist branch-scoped candidates with source/model/version provenance; retries replay without another model call; a human must review each promotion | Core extraction validation, migration, workflow, replay, branch isolation, and atomic review tests pass; UI build and authenticated HTTP tests pending; only entity/claim extraction up to 24,000 characters is implemented; live Ollama quality is unverified |
| Canon integrity | AI proposal cannot mark claim/relation/extraction candidate accepted | Core unit test passes for claims/relations/extraction candidates; extracted claim acceptance requires explicit entity, epistemic-status, and visibility choices |
| Manual override | Reprocessing preserves reviewed override | Core test verifies a second extraction batch leaves a manually corrected and reapproved claim unchanged; reruns create proposals only. Duplicate claims from separately accepted batches are not deduplicated. |
| Temporal query | Relative narrative order and awareness exclude future or unknown facts | Core unit tests cover actor awareness and date-window overlap for exact/ranged journal accounts; relative or unknown timing is excluded instead of guessed; temporal question answering is pending |
| Character agency | User-controlled action is never invented or committed | User-control guard is sent in generation prompt and no story output writes canon; simulated-provider check passes, live-model compliance not verified |
| External conversation bridge | Import versioned transcript segments; detect missing turn ranges and conflicting overlaps; deduplicate same segments; preserve stale context and branch provenance; do not create canonical facts or story turns | Gateway tests cover immutable import, same-segment deduplication, identity conflicts, missing-turn detection, overlap conflict rejection, stale-context retention, and branch snapshots/promotion; API and interactive browser verification remain pending |
| Provider failure | Runtime failure leaves no partial canonical commit | Simulated-provider failure returns 503 with no saved turn or revision change; live Ollama outage behavior remains unverified |
| Story persistence | Create, close/reload, and continue a branch-scoped conversation | Schema v8 migration, atomic turn storage, retry, and branch snapshot tests pass; browser creation, branch selection, and reload persistence verified; local generation remains blocked until Ollama is running |
| Journal note access | List saved notes and open their original source text without crossing workspaces | Source detail and workspace-scope unit test passes; UI compiles; browser verification of the new Journal view and API route is pending |
| Journal event history | Record exact, ranged, relative, or unknown timing with optional source quotes; filter by date without guessing; correct an account without erasing its previous version; isolate edits by branch | Gateway tests cover date validation and overlap, exclusion of uncertain timing, exact source quote, conflicting accounts, append-only corrections, stale-version rejection, and branch isolation; UI build passes; interactive browser and API boundary verification remain pending |
| Context export | Save a portable package with actor, branch, revision, included facts, and exclusions | Browser verifies the downloaded JSON envelope, context manifest, branch/revision provenance, included/excluded fields, and omission of source full text; external sharing and redaction remain user-controlled and unimplemented |
| Saved story export | Export the selected persisted story with branch identity and generation provenance; omit context manifests by default and include them only by explicit choice | `npm run test:story-export` passes JSON privacy, explicit inclusion, Persian text, provenance, and source-preservation checks; TypeScript and production build pass; browser download and rapid-switch export verification remain pending; per-message redaction is not implemented |
| Local API boundary | Auth, origin, loopback, sidecar token, backup, and restore tests | Auth, allowed-origin, preflight, API round-trip tests, and standalone sidecar health/token smoke test passed before later route changes; current source-detail, journal-event, rule-evaluation, scenario-evaluation, extraction, backup, and restore HTTP assertions are unverified because the bundled Python runtime lacks FastAPI and loopback test setup is restricted |
| User workflows | Create workspace, add concepts, review claims/links, preview actor context, branch scenario, reopen a saved story, and back up/restore data | Browser flow verified for workspace, entities, relations, UTF-8 text source import and full-text search, evidence-backed claim review, actor awareness, branch isolation, and saved story reload; extraction and backup/restore controls build but their browser interaction remains unverified |
| Windows desktop package | Tauri shell and bundled backend start/stop on a clean machine | Standalone sidecar built and smoke-tested; Tauri shell build blocked by missing MSVC linker; installer not built |
| File ingestion safety | Size/type/path/archive limits and hostile fixtures | Text/Markdown path is limited to 10 MiB, requires UTF-8 in the UI, and is rechecked by the command gateway for media type, empty content, binary NUL bytes, and size; browser verification confirms a local `.txt` import, revision advance, and searchable excerpt; no source path or archive extraction is accepted; hostile file-picker and Unicode fixtures remain pending |
| Graph/matrix/history consistency | Views reflect the selected branch's canonical relations and revisions | Browser verifies the concept map and matrix show the same directed relationship on a scenario branch and history lists that branch's revisions; automated cross-view edit parity is pending |
| Backup/restore equivalence | Restore elsewhere matches sources, revisions, and official state | Manifest, integrity, foreign-key, FTS, source, revision, schema-v8 migration, and replacement of an open database after validation pass in core tests; authenticated download/restore route tests are pending; separate-device drill pending |
| Local-only path | Full core workflow without cloud or paid API | No cloud dependency in current core/story path; end-to-end model workflow needs a live local Ollama model |
| Windows install | Clean-machine install without preinstalled Python | Not implemented; release blocker |

With backend requirements installed in the project environment, run the full unit and API suite with:

```powershell
python -m unittest discover -s tests\unit -v
```

The complete current-source Python suite passed all 89 tests, including all 12 authenticated API tests, on 2026-10-23. Dependencies were installed into the repository-local .tmp-api-deps directory; the suite required execution outside the sandbox to avoid its first-test stall. The external exchange API test was corrected to match the gateway response shape. Browser, live-model, current-source installer, and clean-machine verification remain open. Existing table references to pending API checks predate this run and must be assessed against the actual route assertions before a release claim.

## Quality targets

Entity F1, relation precision, evidence grounding, retrieval Recall@K, temporal accuracy, context efficiency, narrative continuity, human review cost, import performance, and recovery performance require a fixed bilingual evaluation corpus and rubric. Numeric targets are intentionally unset until a measured baseline exists.

## Definition of Done

- [ ] Windows app installs and launches from a clean machine.
- [ ] Main user workflow is available without a paid API.
- [ ] Files, conversations, and evidence persist across restarts.
- [ ] Graph, matrix, and history share one canonical data source.
- [ ] Relationship edits and approvals appear consistently in every view.
- [ ] Story, characters, and memory persist across turns.
- [ ] Scenario branches cannot alter the primary branch without an explicit, reviewed fast-forward promotion.
- [ ] Provider and model can be changed.
- [ ] AI proposals cannot enter official state without authorization.
- [ ] Full backup and restore is verified on a different location.
- [ ] Core integration and security gates pass.
- [ ] Code, license, documentation, and public build instructions are release-ready.
