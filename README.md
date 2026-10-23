# Living Knowledge Engine

Living Knowledge Engine (LKE) is a Windows-first, local-first application for organizing sources, evidence, knowledge, memories, stories, and alternate scenarios. Story Studio is the first complete user experience; the shared knowledge core also supports research, journaling, and decision work.

The canonical store is versioned SQLite. Every official change passes through a command boundary that checks workspace and branch scope, expected revision, idempotency, and domain constraints, then records an audit event and projection work in the same transaction. AI output is a proposal and does not become accepted knowledge by default.

## Current state

The Python core supports isolated workspaces and snapshot branches, entities, relations, claims, actor beliefs, UTF-8 text/Markdown sources, evidence, full-text search, actor-aware context, persistent story conversations, a sourced journal timeline, deterministic rules, scenario options and assumptions, extraction proposals, revisions, audit records, and an outbox. Scenario branches can be reviewed from their complete command history and explicitly fast-forwarded into an unchanged direct parent; stale or conflicting parent state is rejected. Knowledge Explorer includes a concept map, relationship matrix, source search, human review, an audited editor for entities, relationships, and claims, and an exact-quote extraction workflow for entity and claim candidates from local Ollama. Corrections preserve stable IDs, stay branch-local, and return changed reviewed claims and relationships to proposed status. A new extraction run records proposals without overwriting manually corrected canonical claims. Journal and Scenario Lab use the same canonical store and branch history. Story Studio saves and reloads turns and can request a continuation from a local Ollama model; generated prose remains conversation text and cannot write accepted world facts. The app also exposes full-database backup and validated restore controls. All 66 non-API tests and the production frontend build pass; authenticated API/browser checks for recent workflows, live-model quality, clean-machine recovery, and the Windows installer remain unverified. LKE is still not the complete installable v0.1 product. See [the acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for status.

## Development

Python 3.12 or newer is required for the backend. Install the project and its API dependencies in a virtual environment:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
npm install
```

Run the canonical-core tests with the bundled or installed Python:

```powershell
python -m unittest discover -s tests\unit -v
```

The backup utility supports both the desktop's full-database backup/restore flow and offline CLI operation. Persistent story-turn storage, the local Ollama adapter, and the branch-scoped `lke.exchange.v1` transcript archive are implemented. PDF/Office and incremental extraction, relation/event extraction, transcript export and redaction, live-model acceptance, browser/API verification for recent changes, and packaged Windows installation remain incomplete. Their contracts and validation criteria are documented beside the implementation.

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
