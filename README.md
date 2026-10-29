# Living Knowledge Engine

Living Knowledge Engine (LKE) is a Windows-first, local-first application for organizing sources, evidence, knowledge, memories, stories, and alternate scenarios. Story Studio is the first complete user experience; the shared knowledge core also supports research, journaling, and decision work.

The canonical store is versioned SQLite. Every official change passes through a command boundary that checks workspace and branch scope, expected revision, idempotency, and domain constraints, then records an audit event and projection work in the same transaction. AI output is a proposal and does not become accepted knowledge by default.

## Current state

The Python core supports isolated workspaces and snapshot branches, entities, relations, claims, actor beliefs, UTF-8 text/Markdown sources, evidence, full-text search, actor-aware context, persistent story conversations, a sourced journal timeline, deterministic rules, scenario options and assumptions, extraction proposals, revisions, audit records, and an outbox. Scenario branches can be reviewed from their complete command history and explicitly fast-forwarded into an unchanged direct parent; stale or conflicting parent state is rejected. Knowledge Explorer includes a concept map, relationship matrix, source search, human review, an audited editor for entities, relationships, and claims, and an exact-quote extraction workflow for entity and claim candidates from local Ollama. Corrections preserve stable IDs, stay branch-local, and return changed reviewed claims and relationships to proposed status. A new extraction run records proposals without overwriting manually corrected canonical claims. Journal, transcript exchange, and Scenario Lab workflows use the same canonical store and branch history. Story Studio saves and reloads turns, can request a continuation from a local Ollama model, and can query a character's memory at a narrative order with claim citations; generated prose and answers remain read-only and cannot write accepted world facts. The app also exposes full-database backup, validated restore, and transactional search-index rebuild controls. Core, API, and browser acceptance verify search-index recovery from missing index rows without changing canonical data or revision. Browser acceptance also covers workspace isolation, extraction review, transcript exchange, Journal history, scenario promotion, correction consistency, recovery, story retry, and character-memory temporal scoping; mock-model runs do not establish live-model quality. The Windows installer and clean-machine launch remain unverified, so LKE is not yet the complete installable v0.1 product. See [the acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for status.

## Development

Python 3.12 or newer is required for the backend. Install the project and its API dependencies in a virtual environment:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
npm install
```

For desktop development on Windows, install the Rust/Tauri prerequisites, install the
sidecar build dependency with python -m pip install -e ".[package]", and run
./scripts/build-sidecar.ps1 from PowerShell. Then start the app from the project
root with npm run tauri. Use npm run tauri:build for a desktop build.

In Ubuntu/WSL, npm run tauri starts a Linux desktop build, not a Windows executable.
It needs the Linux Tauri dependencies, a graphical display, Rust, and a Linux sidecar.
Use a separate Linux virtual environment, install .[package], and run
bash scripts/build-sidecar.sh before starting the app. Install Node dependencies
for the operating system running the command; native npm packages are platform-specific.
The Linux/WSL desktop flow has not yet been validated end to end.

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
- [Narrative rules](docs/contracts/NARRATIVE_RULES.md)
- [Integration register](docs/INTEGRATION_REGISTER.md)
- [Acceptance matrix](docs/ACCEPTANCE_MATRIX.md)
- [Operations](docs/OPERATIONS.md)
- [Decisions](DECISIONS.md)

## Data location and privacy

The core library accepts an explicit SQLite path. The desktop application uses a per-user local data directory, keeps cloud processing off, and never treats source text as instructions or permission. Backup/restore equivalence, data deletion, and packaged Windows operation remain release gates; consult [operations](docs/OPERATIONS.md) before using unreleased builds with personal data.

## License

Apache-2.0. See [LICENSE](LICENSE).
