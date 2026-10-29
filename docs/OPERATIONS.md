# Operations

## Development prerequisites

Python 3.12 or later is required for the backend. The current Vite line requires Node.js 20.19+ or 22.12+; Rust/Tauri tooling is required for the desktop shell. Install Python dependencies into an isolated virtual environment with `python -m pip install -e .`, then install frontend dependencies with `npm install`.

Run the desktop in debug mode from the project root with `npm run tauri:dev` (or the existing `npm run tauri` alias). Tauri starts Vite and the native window; Vite hot reloads frontend changes. In debug builds, the desktop launches the Python API from the checkout, so PyInstaller is not part of the normal edit/run cycle. Restart the desktop app after Python changes. The first Rust compile may take several minutes; Cargo reuses its incremental build cache on later runs. If the Python environment is not in `.venv` or `.venv-linux`, set `LORETHRA_DEV_PYTHON` to its interpreter path before launching.

Only packaged desktop builds need the PyInstaller sidecar: install `python -m pip install -e ".[package]"`, run `./scripts/build-sidecar.ps1` on Windows or `bash scripts/build-sidecar.sh` on Linux, then run `npm run tauri:build`.

For Linux/WSL development, run `npm ci --include=optional` inside Linux so npm installs Linux-native optional packages, create a Linux virtual environment, and install the project with `python -m pip install -e .`. Start Tauri from the repository root with `npm run tauri:dev`; this script changes into `apps/desktop`, where Tauri finds `src-tauri/tauri.conf.json`. Do not append `--config`. If Windows and WSL share this checkout, run `npm ci --include=optional` again from the active operating system when switching environments because both use the same `node_modules` directory. Keep the lockfile; `npm ci` recreates the dependency tree from it. If icon artwork changes, regenerate the checked-in PNG and ICO assets with `python scripts/generate-desktop-icons.py` before building. A packaged Linux build additionally requires `.[package]` and `bash scripts/build-sidecar.sh`.

Run core integrity checks with `python -m unittest discover -s tests\unit -v`.

## Local API

The API binds only to `127.0.0.1`. It rejects non-loopback peers and unknown browser origins. Tauri debug builds enable the Vite development origin and run the Python source API; release builds explicitly disable the development origin and launch the bundled sidecar. Data endpoints require a bearer token. The Tauri host generates a per-run token and delivers it to the API process and main webview through a Tauri command. Do not publish the token in logs, URLs, the database, or imported documents. The bundled API sidecar was built and smoke-tested for startup, health, and token enforcement. The Tauri host and installer have not been built because the required Windows C++ linker is not available in the current environment.

The direct API default data path is `%LOCALAPPDATA%\LKE\knowledge.sqlite3`; `LKE_DATA_DIR` can select another private local directory. The Tauri host supplies its per-application local data directory through `LKE_DATA_DIR`. Core callers can supply an explicit database path. SQLite uses WAL and full synchronous commits for file-backed stores.

## Data safety and recovery

The current source importer accepts only UTF-8 `.txt`, `.md`, and `.markdown` files or pasted text, up to 10 MiB. The API stores text content and a display name; it does not accept filesystem paths or unpack archives. The command gateway independently enforces the size limit, permits only `text/plain` and `text/markdown`, and rejects empty text and NUL bytes. PDF, Office, and archive ingestion are unavailable. Duplicate content is identified by SHA-256 and does not create a second source or revision.

Backups use SQLite's online backup API, so a consistent snapshot includes committed data without copying open WAL files. Each `.lkebackup` archive contains the full local database (all workspaces and branches) and a manifest with format/schema versions, byte size, timestamp, and SHA-256 digest. Restore validates archive entries, digest, SQLite integrity, foreign-key references, required tables, and schema version before replacing any database content. The desktop's authenticated restore endpoint streams the archive to a temporary file, validates it, then replaces the open database through SQLite's backup API; the workspace and branch views reload afterward.

In the desktop app, use **Back up** in the top bar to download a complete `.lkebackup` file. Use **Restore** to choose one. Restore replaces every workspace in the installation, so the app asks for confirmation first; download a current backup before restoring if you may need the existing data. Invalid archives are rejected before the active database is changed. The API accepts backup files with a database payload up to 2 GiB.

Use **Rebuild search** to recreate the entity and source full-text indexes from canonical SQLite records. This operation is authenticated, transactionally replaces only the two FTS projections, and does not create a workspace revision or alter canonical rows. If canonical SQLite tables or integrity checks fail, stop writes and restore a verified backup instead; the projection rebuild cannot repair canonical database corruption.

Create a backup while Lorethra is running:

```powershell
lke-backup create "$env:LOCALAPPDATA\LKE\knowledge.sqlite3" "D:\Backups\workspace-2026-10-17.lkebackup"
```

Restore to a new database path with the offline CLI:

```powershell
lke-backup restore "D:\Backups\workspace-2026-10-17.lkebackup" "D:\LKE-Restore\knowledge.sqlite3"
```

For the offline CLI, close Lorethra before replacing its active database. Restore refuses an existing destination unless `--overwrite` is explicitly supplied. Keep backups on a separate device or protected location; a backup beside the database does not protect against device loss. Migration rollback and a clean-machine recovery drill remain release checks.

## Troubleshooting and recovery

If a command conflicts, refresh the branch revision and review the proposed change; do not retry against the new revision without revalidation. Story generation is saved only after the provider returns and the expected revision still matches; provider failure or a conflict leaves no partial turn. If entity or source search results are missing or stale, run **Rebuild search** and confirm search results and the unchanged revision. If canonical SQLite tables or integrity checks fail, restore a verified backup before continuing.

## Release operations still required

Clean Windows installation without system Python, sidecar start/stop, token rotation, schema upgrade, import size limits, prompt-injection fixtures, separate-device restore equivalence, and uninstall/data-retention behavior must all be exercised before v0.1 release.
