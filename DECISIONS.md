# Architecture decisions

Baseline date: 2026-10-17. This records the decisions in the supplied LKE v1.1 plan. It does not claim that the application or integrations are implemented.

## AD-001: One local-first product

**Decision:** Build LKE as a modular monolith. Story Studio is the primary v0.1 experience; Knowledge Explorer, Journal & Memory, and Decision & Scenario Lab use the shared core.

**Reason:** A shared source of truth preserves evidence, memory, revisions, and workspace isolation across domains.

## AD-002: Canonical data authority

**Decision:** A versioned SQLite model is the sole canonical store. GraphRAG, LLMs, agents, and UI components cannot write canonical rows directly. All official changes use a validated and authorized command gateway.

**Consequences:** Graph, FTS, embeddings, and summaries are rebuildable projections. Every change is attributable, revision-aware, and auditable.

## AD-003: Windows desktop and modular boundaries

**Decision:** The planned v0.1 stack is React/TypeScript, Tauri 2, and a Python/FastAPI sidecar.

**Validation still required:** Clean Windows install without system Python, local API security, startup/shutdown behavior, and packaging of the sidecar.

## AD-004: Local default, provider adapters

**Decision:** Ollama is the default model runtime. Provider and model capabilities are registered independently. External and paid routes are optional, scoped, and user-consented.

**Boundary:** Sign-in to an eligible ChatGPT or Codex route is not access to normal ChatGPT history, memory, or unlimited plan usage. Actual eligibility and quotas are runtime conditions.

## AD-005: Search and graph

**Decision:** SQLite FTS5 is the initial full-text search. Cytoscape.js is the primary graph UI. Vector and advanced GraphRAG retrieval remain behind replaceable adapters.

**Candidates to evaluate:** sqlite-vec; a lightweight internal extraction/retrieval pipeline; Cognee first for a GraphRAG trial; Graphiti for temporal relation experiments; LightRAG for advanced retrieval. None is a second source of truth.

## AD-006: Document processing

**Decision:** Docling is the primary document-ingestion candidate. LangExtract is optional and must be validated in our own structured-output layer.

**Validation still required:** Supported Windows formats, incremental reprocessing, evidence anchors, and reliable output quality in Persian and English.

## AD-007: Existing project reuse

**Decision:** Do not merge Raggi, GlyphMend, Synthora, SmartPack, Ariadne, or Story Studio codebases by default. Create a reuse register after examining each project's contracts, tests, license, dependencies, and adapter cost.

## AD-008: Versioned conversation exchange

**Decision:** Use a versioned bridge for context export and transcript import. Detect missing turns, deduplicate transcript imports, and reject stale changes for review.

**Boundary:** The exchange format is an LKE contract, not an OpenAI API.

## AD-009: Release integrity gates

**Decision:** The release suite must cover canonical integrity, workspace and branch isolation, temporal leakage, character agency, idempotency, stale revisions, provider failures, backup/restore, and local-only operation. Quality thresholds follow a frozen benchmark corpus and rubric.

## Open decisions

- Confirm the final open-source license before public release; Apache-2.0 is the plan's proposal, not yet applied.
- Benchmark local extraction and embeddings on supported Windows hardware.
- Verify optional provider sign-in, quotas, and Codex app-server behavior.
- Decide whether optional graph or vector frameworks add measurable value.
- Set minimum hardware after CPU, memory, and recovery benchmarks.
