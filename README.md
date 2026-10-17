# Living Knowledge Engine

Living Knowledge Engine (LKE) is a local-first knowledge and memory platform. Story Studio is the first complete user experience; Knowledge Explorer, Journal & Memory, and Decision & Scenario Lab are views over the same canonical data core.

## Status

This branch establishes the implementation baseline and repository shape. It does not yet contain a runnable application. A feature is implemented only after its behavior and acceptance checks exist.

## Product commitments

- Windows-first, local-first, single-user deployment for v0.1.
- One versioned SQLite store is the source of truth. Graphs, indexes, embeddings, and summaries are rebuildable projections.
- Sources and evidence remain traceable. Conflicts and uncertainty stay visible.
- AI produces proposals. Official records change only through a validated and authorized command path.
- External providers are optional, require explicit data scope, and never receive content automatically.
- Story and scenario branches remain isolated from the main timeline.

## Planned technology baseline

React and TypeScript; Tauri 2; Python and FastAPI; SQLite with FTS5; Cytoscape.js for graph views; Ollama as the default local model runtime. Windows packaging, model capability, and optional framework choices remain subject to DECISIONS.md.

## Repository map

- apps/desktop: Tauri desktop shell.
- frontend/src: Story, knowledge, journal, scenario, and shared UI.
- backend/lke: Core, ingestion, memory, retrieval, AI, narrative, scenario, adapters, and API.
- schemas: Versioned exchange and persistence schemas.
- tests: Fixtures, golden data, unit, integration, and end-to-end checks.
- docs: Architecture, contracts, decisions, evaluation, and operations.

## Implementation order

Define shared identifiers, revisions, and the command gateway first. Then build ingestion, review, knowledge views, AI context, Story Studio, scenario branches, external exchange, and recovery against the same reference workspace and acceptance invariants. See PRODUCT.md, ARCHITECTURE.md, and DECISIONS.md.

Detailed contracts are added alongside the code and tests that enforce them; design documents are not evidence of working features.
