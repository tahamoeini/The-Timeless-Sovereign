# Operations

## Development prerequisites

Python 3.12 or later is required for the backend. The current Vite line requires Node.js 20.19+ or 22.12+; Rust/Tauri tooling is required for the desktop shell. Install Python dependencies into an isolated virtual environment with `python -m pip install -e .`, then install frontend dependencies with `npm install`. Before desktop dev/build, bundle the local API with `python -m pip install -e ".[package]"` and `./scripts/build-sidecar.ps1`.

Run core integrity checks with `python -m unittest discover -s tests\unit -v`.

## Local API

The API binds only to `127.0.0.1`. It rejects non-loopback peers and unknown browser origins. Data endpoints require a bearer token. The Tauri host generates a per-run token and delivers it to the sidecar and main webview through a Tauri command. Do not publish the token in logs, URLs, the database, or imported documents. The Tauri binary and sidecar have not yet been built or runtime-tested.

The default data path is `%LOCALAPPDATA%\LKE\knowledge.sqlite3` (resolved from the user's home `AppData/Local/LKE`); `LKE_DATA_DIR` can select another private local directory for development. Core callers can supply an explicit database path. SQLite uses WAL and full synchronous commits for file-backed stores.

## Data safety

Current schema migrations are versioned, but migration upgrade/rollback procedures are not release-tested. No backup/restore utility is implemented yet. Before testing unreleased code, use disposable data and copy the database plus its WAL state only after closing the app. Do not promise recoverability until a manifest-checked backup can be restored and compared on a separate location.

## Troubleshooting and recovery

If a command conflicts, refresh the branch revision and review the proposed change; do not retry against the new revision without revalidation. If the local model stops, canonical records remain in SQLite; generated proposals should be discarded or retried. If FTS or another projection is damaged, the future recovery operation must rebuild it from canonical sources. A verified rebuild command is not yet available.

## Release operations still required

Clean Windows installation without system Python, sidecar start/stop, token rotation, schema upgrade, import size limits, prompt-injection fixtures, backup integrity checks, restore equivalence, and uninstall/data-retention behavior must all be exercised before v0.1 release.
