# Browser acceptance evidence

Verified on 2026-10-23 using current source, headless installed Microsoft Edge, Playwright, a Vite development server at `http://127.0.0.1:5173`, and the authenticated API at `http://127.0.0.1:48124`.

The API used `output/playwright/acceptance-data` as an isolated data directory. The frontend and scripts used the dedicated test token `lke-browser-acceptance-local-only`. This token is only for these loopback test servers; desktop launches provision their own token.

| Script | Executed evidence |
|---|---|
| `tests/browser-workspace.py` | Workspace creation through the welcome form; API-seeded character appears only in its workspace; deliberate entity-load failure shows a scoped error without old records; retry recovers after removing the failure; switching away and back; persistence after reload |
| `tests/browser-story-export.py` | Actual JSON downloads; Persian prose; workspace and branch identity; context omitted by default; prompts omitted by user choice; context included by explicit choice |
| `tests/browser-backup.py` | Actual backup download and archive envelope; confirmed restore; workspace created after backup disappears after restore and reload |

The export conversation was seeded through authenticated commands. This does not verify live model generation. The recovery test compares workspace identities and the archive envelope; source, revision, FTS, and audit recovery have separate Python tests. It does not establish separate-device recovery or clean-machine installation.

Run these scripts only against isolated acceptance data. The backup script restores the complete API database. All scripts create persistent test fixtures. They require the two servers above to be running and Playwright to be importable. Each script launches installed Edge with `channel="msedge"`; no Chromium download is required.

Remaining browser gates include delayed generation and lost-response retries, stale revision recovery, rapid overlapping scope loads, source extraction/review, correction parity across views, and branch-promotion review. Windows installer and live Ollama acceptance remain separate gates.
