# Lorethra

Lorethra is a Windows-first, local-first application for organizing sources, evidence, knowledge, memories, stories, and alternate scenarios. Story Studio is its RPG authoring and play experience; the shared knowledge core also supports research, journaling, and decision work. The RPG upgrade is in progress and is not yet release-verified.

The canonical store is versioned SQLite. Every official change passes through a command boundary that checks workspace and branch scope, expected revision, idempotency, and domain constraints, then records an audit event and projection work in the same transaction. AI output is a proposal and does not become accepted knowledge by default.

## Current state

The Python core supports isolated workspaces and snapshot branches, entities, relations, claims, actor beliefs, UTF-8 text/Markdown sources, evidence, full-text search, actor-aware context, persistent story conversations, a sourced journal timeline, deterministic rules, scenario options and assumptions, extraction proposals, revisions, audit records, and an outbox. Scenario branches can be reviewed from their complete command history and explicitly fast-forwarded into an unchanged direct parent; stale or conflicting parent state is rejected. Knowledge Explorer includes a concept map, relationship matrix, source search, human review, an audited editor for entities, relationships, and claims, and an exact-quote extraction workflow for entity and claim candidates from local Ollama. Corrections preserve stable IDs, stay branch-local, and return changed reviewed claims and relationships to proposed status. A new extraction run records proposals without overwriting manually corrected canonical claims. Journal, transcript exchange, and Scenario Lab workflows use the same canonical store and branch history. Story Studio saves and reloads turns, can request a continuation from a local Ollama model, and can query a character's memory at a narrative order with claim citations; generated prose and answers remain read-only and cannot write accepted world facts. The app also exposes full-database backup, validated restore, and transactional search-index rebuild controls. Core, API, and browser acceptance verify search-index recovery from missing index rows without changing canonical data or revision. Browser acceptance also covers workspace isolation, extraction review, transcript exchange, Journal history, scenario promotion, correction consistency, recovery, story retry, and character-memory temporal scoping; mock-model runs do not establish live-model quality. The Windows installer and clean-machine launch remain unverified, so Lorethra is not yet the complete installable v0.1 product. See [the acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for status.

Story Studio also has versioned worlds and isolated adventures, d20 checks, reviewed state proposals, scoped memories, NPC and coordinate-map panels, local image attachments, and a reader/print view. The home view puts Continue first and keeps setup/import controls collapsed; play keeps the transcript central and opens map, NPC, memory, state and gallery details on demand. Each committed adventure scene creates a sourced event-memory proposal for review; edits and retries create a fresh proposal and stale source memories are excluded. Provider adapters include local Ollama, OpenAI API, Claude API, Codex app-server, and hosted or locally served Hugging Face models; availability depends on configuration and live provider testing remains incomplete.

Portable `.lke-world` and `.lke-adventure` packages support preview and duplicate-by-default import. Lorethra also converts MNO RPG Engine `.mno-world` v1 and `.mno-adv` v2 exports: import the world first, then preview its adventure. Imported transcript roles, map points, portraits, cast, stats and trackers are preserved with documented conversions. Imported author thoughts and NPC secrets stay out of model context, MNO formulas are never executed, and old check narration is not treated as a verified die roll. Package archives can contain private world or character notes; inspect them before sharing. Browser acceptance, historical RPG-state reconstruction after edits, live-provider quality and several Windows release gates remain open; see the [platform audit](docs/STORY_STUDIO_PLATFORM_AUDIT.md) and [MNO import contract](docs/contracts/MNO_IMPORT.md).

## Development

Python 3.12 or newer is required for the backend. Install the project and its API dependencies in a virtual environment:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
npm install
```

For desktop development on Windows, install the Rust/Tauri prerequisites and the
Python project in the virtual environment above, then run `npm run tauri:dev` from
the project root. This opens the native desktop window, starts Vite with frontend
hot reload, and runs the Python API directly from source. `npm run tauri` remains
an equivalent shortcut. The first Rust compile can take time; later launches and
Rust rebuilds use Cargo's incremental cache. Python source edits require restarting
the desktop app. Build the PyInstaller sidecar only when preparing a packaged
desktop build: install `.[package]`, run `./scripts/build-sidecar.ps1`, then use
`npm run tauri:build`.

In Ubuntu/WSL, `npm run tauri:dev` starts a Linux desktop build, not a Windows
executable. It needs the Linux Tauri dependencies, a graphical display, Rust,
Node dependencies installed for Linux, and the Python project installed in the
active virtual environment. The debug app uses the Python source API; no Linux
sidecar build is needed for development. Run it from the project root without
adding `--config`; the script enters `apps/desktop` and Tauri discovers its
configuration there. The checked-in icon set is required
for the Linux window and the Windows installer targets. Regenerate it with
`python scripts/generate-desktop-icons.py` after editing the icon generator.

See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/) for the
required Linux packages and Rust. From the project root, a typical WSL setup is:

```bash
npm ci --include=optional
python3 -m venv .venv-linux
. .venv-linux/bin/activate
python -m pip install -e .
npm run tauri:dev
```

To create a packaged Linux build, install `.[package]`, build the sidecar with
`bash scripts/build-sidecar.sh`, and run `npm run tauri:build` instead.

`npm ci` installs the native optional packages for the current operating system.
This checkout may also be used from Windows, so its `node_modules` directory can
contain Windows binaries when WSL starts. `npm install` can then report that the
tree is up to date while the Linux Tauri binding is missing. When switching
between Windows and WSL in this same checkout, run `npm ci --include=optional`
in the active environment each time; this replaces the shared `node_modules`
tree for that operating system. Keep `package-lock.json` unchanged.

The Linux/WSL desktop flow still needs a fresh end-to-end run; the configured
bundle targets are Windows installers. Native npm packages depend on the OS
running the command, so install dependencies from the same OS before launching
Tauri.
    npm run tauri

Run the canonical-core tests with the bundled or installed Python:

```powershell
python -m unittest discover -s tests\unit -v
```

The backup utility supports both the desktop's full-database backup/restore flow and offline CLI operation. Persistent story-turn storage, the local Ollama adapter, the branch-scoped `lke.exchange.v1` transcript archive and browser importer, portable saved-story JSON export, and narrative-order character-memory Q&A are implemented. Story export omits character context manifests by default and offers explicit inclusion. PDF/Office and incremental extraction, relation/event extraction, calendar-date Q&A over Journal events, per-message export redaction, live-model acceptance, and packaged Windows installation remain incomplete. Their contracts and validation criteria are documented beside the implementation.

## Product and technical contracts

- [Product definition](PRODUCT.md)
- [Architecture](ARCHITECTURE.md)
- [Data model](docs/contracts/DATA_MODEL.md)
- [Command contracts](docs/contracts/COMMAND_CONTRACTS.md)
- [AI provider specification](docs/contracts/AI_PROVIDER_SPEC.md)
- [Context protocol](docs/contracts/CONTEXT_PROTOCOL.md)
- [Exchange protocol](docs/contracts/EXCHANGE_PROTOCOL.md)
- [World package format](docs/contracts/WORLD_PACKAGE.md)
- [Narrative rules](docs/contracts/NARRATIVE_RULES.md)
- [Integration register](docs/INTEGRATION_REGISTER.md)
- [Acceptance matrix](docs/ACCEPTANCE_MATRIX.md)
- [Operations](docs/OPERATIONS.md)
- [Decisions](DECISIONS.md)

## Data location and privacy

The core library accepts an explicit SQLite path. The desktop application uses a per-user local data directory. Local providers can run without cloud processing; selecting a configured external provider sends the relevant prompt and context to that provider. Source and imported world text are story data, not authorization. Backup/restore equivalence, data deletion, and packaged Windows operation remain release gates; consult [operations](docs/OPERATIONS.md) before using unreleased builds with personal data.

## License

Apache-2.0. See [LICENSE](LICENSE).
