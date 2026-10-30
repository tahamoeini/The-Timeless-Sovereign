# Lorethra

Lorethra is a local-first knowledge and narrative platform. Story Studio is its RPG creation and play experience, built on a shared SQLite core for knowledge, journal, memory, and scenario work. The current implementation is broad but still in release development; the Windows desktop installer and clean-machine workflow are not yet release-verified.

SQLite is canonical. Search indexes and other derived views can be rebuilt. All accepted writes pass through validated commands with workspace and branch checks, revision history, audit records, and recovery. AI-generated narrative and extracted memories remain proposals; they do not silently become canon. External providers require explicit provider-specific consent.

## Start locally

Requirements: Python 3.12+, Node.js, and the Rust/Tauri Windows prerequisites.

~~~powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
npm ci
npm run tauri:dev
~~~

For frontend and API setup, backup and restore, packaging, and WSL notes, see [Operations](docs/OPERATIONS.md). Run core integrity tests with `python -m unittest discover -s tests\unit -v`. Browser acceptance setup is documented in [tests/README.md].

## Product workflows

- **Story Studio:** create or choose a world, prepare a protagonist, start or resume an isolated adventure, and review proposed changes.
- **Knowledge Explorer:** preserve sources and evidence, extract candidates, and review changes before committing them.
- **Journal & Memory:** keep source-linked personal accounts and scoped memories with their recorded time.
- **Decision & Scenario Lab:** compare assumptions on an isolated branch without changing baseline facts.
- **Recovery:** export portable story packages and create or restore a full local database backup.

A paid provider is not required for local data storage or deterministic mechanics. Live local-model behavior depends on a configured Ollama service.

## Project status and documentation

- [Project status and prioritized backlog](docs/PROJECT_STATUS.md) — what is implemented, partial, open, or release-blocking.
- [Changelog](CHANGELOG.md) — readable history of this PR's changes and dated project milestones.
- [Acceptance matrix](docs/ACCEPTANCE_MATRIX.md) — measurable release evidence and remaining gates.
- [Product definition](PRODUCT.md) — user outcome, core workflows, and product boundaries.
- [Architecture](ARCHITECTURE.md) and [architecture decisions](DECISIONS.md) — ownership, write paths, and durable choices.
- [Documentation index](docs/README.md) — guide to contracts, operations, workflows, and narrative guidance.

See [MNO import](docs/contracts/MNO_IMPORT.md) before using converted MNO packages. Package archives may include private story material; review export previews and files before sharing.

## Data location and privacy

The core accepts an explicit SQLite path. The desktop uses a per-user local data directory. Selecting an external provider sends the allowed prompt and context to that service after matching consent; private author notes, private NPC and protagonist identity profiles, imported MNO lorebook references, actor-scoped facts, unshared memories, and unclassified story notes are filtered from remote context. Provider retention and cancellation behavior remain subject to the provider's terms and live verification. Backups contain all workspaces and branches, so store them accordingly.
