# Living Knowledge Engine

Living Knowledge Engine (LKE) is a Windows-first, local-first application for organizing sources, evidence, knowledge, memories, stories, and alternate scenarios. Story Studio is the first complete user experience; the shared knowledge core also supports research, journaling, and decision work.

The canonical store is versioned SQLite. Every official change passes through a command boundary that checks workspace and branch scope, expected revision, idempotency, and domain constraints, then records an audit event and projection work in the same transaction. AI output is a proposal and does not become accepted knowledge by default.

## Current state

This repository has been reset to the LKE baseline. The Python core supports workspaces, isolated snapshot branches, entities, relations, claims, actor beliefs, text sources, evidence, full-text search, relative-order actor context, persistent story conversations, revisions, audit records, and an outbox. Knowledge Explorer includes a concept map, a branch-scoped relationship matrix, source search, claim review, and revision history. Story Studio can save and reload turns and request a continuation from a local Ollama model; generated prose is retained as conversation text and cannot write accepted world facts. The adapter and UI are implemented, but live generation has not been verified because no Ollama service/model was running during validation. LKE is still not the complete installable v0.1 product. See [the acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for implementation and verification status.

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

The offline backup/restore command and its integrity checks are implemented. Persistent story-turn storage and the local Ollama adapter are implemented, but the full Story Studio workflow, PDF/Office extraction, journal timeline, scenario evaluation, exchange import/export, live-model acceptance, and packaged Windows installation remain incomplete. Their contracts and validation criteria are documented beside the implementation.

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
