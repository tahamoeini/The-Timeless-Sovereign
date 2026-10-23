# Browser acceptance evidence

Verified on 2026-10-23 using current source, headless installed Microsoft Edge, Playwright, a Vite development server at `http://127.0.0.1:5173`, and the authenticated API at `http://127.0.0.1:48124`.

The established browser suite used `output/playwright/acceptance-data`; search-projection recovery used its own `output/playwright/projection-rebuild-data` directory. The frontend and scripts used the dedicated test token `lke-browser-acceptance-local-only`. This token is only for these loopback test servers; desktop launches provision their own token.

| Script | Executed evidence |
|---|---|
| `tests/browser-workspace.py` | Workspace creation through the welcome form; API-seeded character appears only in its workspace; deliberate entity-load failure shows a scoped error without old records; retry recovers after removing the failure; switching away and back; persistence after reload |
| `tests/browser-ingestion.py` | Import a UTF-8 Persian/emoji `.txt` file; verify exact local source content and full-text search; reject a text file with a NUL byte without creating a source or advancing the revision |
| `tests/browser-extraction.py` | Import a source through the UI; run extraction through the UI against deterministic mock Ollama output; verify exact source quotes, proposed-only state, reviewed entity/claim acceptance with explicit confidence and visibility, rejection, and one structured model call |
| `tests/browser-scope-races.py` | Hold a branch response and a workspace response while the user switches scopes; confirm delayed responses cannot replace or reveal records from a non-selected branch or workspace |
| `tests/browser-stale-revision.py` | Make an external local write after the UI loads; confirm the stale UI write is rejected without partial data; refresh, retry, and verify the current revision and single saved record |
| `tests/browser-exchange.py` | Import transcript segments in the UI; verify client-computed hashes, missing turn ranges, stale-context retention, duplicate detection, and that transcript text/proposed references do not create story turns or canonical records |
| `tests/browser-story-export.py` | Actual JSON downloads; Persian prose; workspace and branch identity; context omitted by default; prompts omitted by user choice; context included by explicit choice |
| `tests/browser-backup.py` | Actual backup download and archive envelope; confirmed restore; workspace created after backup disappears after restore and reload |
| `tests/browser-search-rebuild.py` | Reject an unauthenticated rebuild; delete derived entity/source search rows in the isolated test database; rebuild through the UI; verify both search paths recover and the workspace revision stays unchanged |
| `tests/browser-scenario.py` | Scenario branch creation in the UI; decision with linked claim and source; option assumption and conditional rule result; parent remains unchanged before approval; full branch history review gates promotion; explicit promotion preserves the canonical claim |
| `tests/browser-correction.py` | Correct an accepted relationship and verify renewed review across graph, matrix, and history; correct an entity's label, type, and properties while preserving its ID across the graph and matrix; correct an accepted claim's epistemic context, preserve its evidence, review it again, and inspect before/after revision payloads |
| `tests/browser-journal.py` | Save and reopen an original source note; record exact, ranged, relative, and unknown timing; verify a sourced quote and date-overlap filters; correct an account while preserving its prior version and source; correct it on a scenario branch without changing main; switch workspaces and verify the note and timeline remain scoped |
| `tests/browser-story-retry.py` | Delay a local story response; verify generation disables repeated submission; commit the turn then drop its response; retry the same request and verify the conversation contains one user/assistant turn pair and the local model was called once |
| `tests/browser-temporal-query.py` | Ask at a story order with no eligible memory and verify a deterministic insufficient response without a model call; query at a later order and verify future, unreviewed, and actor-unaware claims are omitted from mock Ollama input, the eligible claim is cited in the UI, and the revision is unchanged |

The export conversation was seeded through authenticated commands. This does not verify live model generation. The recovery test compares workspace identities and the archive envelope; source, revision, FTS, and audit recovery have separate Python tests. It does not establish separate-device recovery or clean-machine installation.

Run these scripts sequentially against isolated acceptance data. The backup script restores the complete API database, and each script creates persistent test fixtures. They require the two servers above to be running and Playwright to be importable. The extraction and story retry scripts both bind Ollama's loopback port `11434`, which must be free. Each script launches installed Edge with `channel="msedge"`; no Chromium download is required.

The extraction and story retry browser tests each start a deterministic mock Ollama service on `127.0.0.1:11434`; that port must be free. They verify the UI-to-API workflow and idempotent retry, not real model quality. The browser flows listed here were run against isolated local acceptance data. Live Ollama quality, Windows packaging, and clean-machine installation remain separate gates.
