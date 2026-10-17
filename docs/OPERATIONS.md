# Operations

## Development prerequisites

Python 3.12 or later is required for the backend. The current Vite line requires Node.js 20.19+ or 22.12+; Rust/Tauri tooling is required for the desktop shell. Install Python dependencies into an isolated virtual environment with `python -m pip install -e .`, then install frontend dependencies with `npm install`. Before desktop dev/build, bundle the local API with `python -m pip install -e ".[package]"` and `./scripts/build-sidecar.ps1`.

Run core integrity checks with `python -m unittest discover -s tests\unit -v`.

## Local API

The API binds only to `127.0.0.1`. It rejects non-loopback peers and unknown browser origins. Data endpoints require a bearer token. The Tauri host generates a per-run token and delivers it to the sidecar and main webview through a Tauri command. Do not publish the token in logs, URLs, the database, or imported documents. The Tauri binary and sidecar have not yet been built or runtime-tested.

The default data path is `%LOCALAPPDATA%\LKE\knowledge.sqlite3` (resolved from the user's home `AppData/Local/LKE`); `LKE_DATA_DIR` can select another private local directory for development. Core callers can supply an explicit database path. SQLite uses WAL and full synchronous commits for file-backed stores.

## Data safety and recovery

Backups use SQLite's online backup API, so a consistent snapshot includes committed data without copying open WAL files. Each `.lkebackup` archive contains one database snapshot and a manifest with format/schema versions, byte size, timestamp, and SHA-256 digest. Restore validates archive entries, digest, SQLite integrity, required tables, and schema version before installing the target database.

Create a backup while LKE is running:

```powershell
lke-backup create "$env:LOCALAPPDATA\LKE\knowledge.sqlite3" "D:\Backups\workspace-2026-10-17.lkebackup"
```

Restore to a new database path:

```powershell
lke-backup restore "D:\Backups\workspace-2026-10-17.lkebackup" "D:\LKE-Restore\knowledge.sqlite3"
```

Close LKE before restoring over its active database. Restore refuses an existing destination unless `--overwrite` is explicitly supplied. Keep backups on a separate device or protected location; a backup beside the database does not protect against device loss. Migration rollback and a clean-machine recovery drill remain release checks.

## Troubleshooting and recovery

If a command conflicts, refresh the branch revision and review the proposed change; do not retry against the new revision without revalidation. If the local model stops, canonical records remain in SQLite; generated proposals should be discarded or retried. If FTS or another projection is damaged, restore a verified backup before continuing; projection rebuild from canonical sources remains pending.

## Release operations still required

Clean Windows installation without system Python, sidecar start/stop, token rotation, schema upgrade, import size limits, prompt-injection fixtures, separate-device restore equivalence, and uninstall/data-retention behavior must all be exercised before v0.1 release.
