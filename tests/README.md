# Validation and browser acceptance

## Core integrity suite

Use the active project Python environment with the backend installed:

~~~powershell
python -m unittest discover -s tests\unit -v
~~~

For focused modules, set PYTHONPATH to backend (and any repository-local optional test dependencies required by the environment). Keep TEMP and TMP inside the repository when a test needs temporary files. Add negative and recovery cases beside each changed contract. The suite uses synthetic story data; it does not establish live-model quality or installed-desktop behavior.

## Browser acceptance prerequisites

The existing browser scripts were run on 2026-10-23 with installed Microsoft Edge, Playwright, Vite at 127.0.0.1:5173, an authenticated API at 127.0.0.1:48124, and isolated local acceptance data. They use the dedicated local-only token `lke-browser-acceptance-local-only`; desktop launches provision their own token. Do not reuse the test token outside isolated loopback acceptance.

Run scripts sequentially against disposable test data. Each script creates persistent fixtures; the backup script restores the complete API database. The extraction and story-retry scripts start deterministic mock Ollama services on port 11434, which must be free. No script listed here proves live model quality, clean-machine installation, or separate-device recovery.

| Script | Workflow evidence |
|---|---|
| tests/browser-workspace.py | Workspace creation, scoped records, load failure and retry, scope switching, reload persistence |
| tests/browser-ingestion.py | Persian/emoji text import, exact source preservation, full-text search, NUL-byte rejection |
| tests/browser-extraction.py | Mock Ollama extraction, exact source quotes, proposal review, accept and reject |
| tests/browser-scope-races.py | Delayed workspace/branch responses cannot replace the selected scope |
| tests/browser-stale-revision.py | Stale UI write rejection, refresh, and safe retry |
| tests/browser-exchange.py | Transcript gaps, duplicates, stale context, provenance, and separation from canon |
| tests/browser-story-export.py | Actual JSON download, Persian content, branch provenance, prompt/context choices |
| tests/browser-backup.py | Actual backup download and confirmed restore |
| tests/browser-search-rebuild.py | Authenticated FTS rebuild from canonical records without a revision change |
| tests/browser-scenario.py | Isolated scenario assumptions, conditional outcomes, history review, explicit promotion |
| tests/browser-correction.py | Entity, relationship, and claim correction across graph, matrix, and history |
| tests/browser-journal.py | Source notes, time precision, date overlap, correction history, branch/workspace scope |
| tests/browser-story-retry.py | Mock response delay, idempotent retry after a committed response is lost |
| tests/browser-temporal-query.py | Future/private/unreviewed knowledge filtering, citations, and empty-context behavior |

These scripts exercise established Knowledge, Journal, Scenario, exchange, backup, and story flows. New RPG, package-import, provider-consent, lifecycle, and narrow-window behavior must be separately reported in the acceptance matrix with its exact fixture and validation boundary.

## Interpreting results

- Unit tests prove deterministic code paths covered by those tests.
- Authenticated API tests prove the local API boundary exercised by those tests.
- Browser tests prove the visible workflow and fixture used; a mocked provider does not prove model quality.
- A production frontend build proves TypeScript and bundling, not browser behavior.
- A successful sidecar smoke does not prove installer UX, a visible native window, restart recovery, or clean-machine setup.
- Live provider, Windows desktop, RTL/mixed-script, hostile-package, and separate-device recovery results must be recorded separately.
