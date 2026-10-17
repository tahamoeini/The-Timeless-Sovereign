# Living Knowledge Engine

Living Knowledge Engine (LKE) is a Windows-first, local-first application for organizing sources, evidence, knowledge, memories, stories, and alternate scenarios. Story Studio is the first complete user experience; the shared knowledge core also supports research, journaling, and decision work.

The canonical store is versioned SQLite. Every official change passes through a command boundary that checks workspace and branch scope, expected revision, idempotency, and domain constraints, then records an audit event and projection work in the same transaction. AI output is a proposal and does not become accepted knowledge by default.

## Current state

This repository has been reset to the LKE baseline. The initial Python core supports workspaces, isolated snapshot branches, entities, relations, claims, text sources, evidence, full-text search, revisions, audit records, and an outbox. It is an implementation foundation, not yet the complete installable v0.1 product described in the plan. See [the acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for what is implemented and what still needs an end-to-end implementation and proof.

## Development

Python 3.12 or newer is required for the backend. Install the project and its API dependencies in a virtual environment:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
```

Run the canonical-core tests with the bundled or installed Python:

```powershell
python -m unittest discover -s tests\unit -v
```

The desktop shell, ingestion pipeline, AI adapters, narrative experience, scenario lab, and backup/restore workflow are not yet complete. Their contracts and validation criteria are documented beside the implementation.

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

The core library accepts an explicit SQLite path. The desktop application will use a per-user local data directory, keep cloud processing off unless the user chooses a provider, and never treat source text as instructions or permission. Backup, restore, deletion, and packaged Windows operation remain release gates; consult [operations](docs/OPERATIONS.md) before using unreleased builds with personal data.

## License

Apache-2.0. See [LICENSE](LICENSE).
