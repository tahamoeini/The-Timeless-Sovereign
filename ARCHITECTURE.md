# Architecture baseline

## Shape

LKE is a modular monolith using ports and adapters around one canonical data store. For the user it is one Windows desktop application. Internal boundaries separate domain rules, persistence, extraction, model execution, retrieval, and presentation.

```text
Tauri desktop shell
  React + TypeScript UI
  Python + FastAPI local sidecar
    Application services and command gateway
      Canonical knowledge and memory core
        SQLite + FTS5 + source archive
      Derived graph, search, embedding, and summary projections
      AI gateway and adapters
        Ollama by default; optional, consented providers
```

The diagram describes request flow, not permission to write around the command gateway.

## Ownership boundaries

| Module | Owns or does | Canonical write authority |
| --- | --- | --- |
| Source manager | Original files, versions, hashes, provenance | Source records through commands |
| Extraction | Document IR and candidate entities, claims, relations, events, rules, style | None; reviewable proposals only |
| Knowledge core | Stable identities, claims, relations, evidence links, epistemic status | Yes, through validated commands |
| Memory and history | Revisions, branches, event history, valid and recorded time | Yes, through validated commands |
| Graph and search | Graph, FTS, embedding, summary projections | None; rebuildable |
| Context compiler | Relevant, permission-filtered context and manifest | None |
| Narrative and scenario | Proposed scene deltas, actor knowledge, rules, scenario results | Only through commands; scenarios stay isolated |
| AI gateway and agent runtime | Model capability checks, inference, bounded tools, audit | None; agent writes use the command gateway |
| Application shell | Navigation and interaction | None |

## Canonical write path

Every mutation follows: proposed change -> validate -> authorize -> commit -> append revision and audit -> rebuild or invalidate projections.

A command carries workspace ID, operation, target, expected revision, actor, reason, and idempotency key. Data change, revision, and projection outbox entry commit atomically. A stale expected revision is surfaced for review. Reusing an idempotency key cannot apply a second change. Append-only audit history does not replace a defined personal-data deletion policy.

## Data and time model

The common model includes Workspace; Source and SourceVersion; Evidence; Entity and Alias; Claim; typed, directed, scoped Relation; Event; State; actor-scoped Belief or Knowledge; Rule; Revision; Branch; Conversation and Turn; Scenario; StyleProfile; Job; and Approval.

Review status is independent of epistemic status. A source can support a proposed claim without making it true in the domain. Conflicting evidence is retained with provenance.

The time model distinguishes valid time, recorded time, actor awareness time, narrative order, and branch revision. Branches fork from a specific revision and remain independently recoverable. Promoting a branch is explicit and auditable; automatic conflict merges are out of scope for v0.1.

## Ingestion and derived views

Ingestion records stable source IDs, content hashes, versions, type, language, parser/extractor/schema/model versions, and processing state. A document is normalized to a Document IR before candidate extraction. Every candidate points to a retrievable source anchor or explicit user statement. Reimport compares file and chunk hashes; changed evidence prompts review and never silently removes an approved fact.

SQLite and the versioned canonical model are authoritative. FTS, graph layout, embeddings, summaries, and other indexes are projections that can be rebuilt. A graph or matrix edit emits a domain command rather than writing database rows directly.

## Context and model execution

Each context request specifies purpose, workspace, domain, time, branch, actor, access scope, token budget, and target model capability. Retrieval applies deterministic filters before text, semantic, and graph ranking. The output manifest identifies included and omitted information, reasons, provenance, status, revision, and uncertainty.

The AI gateway uses capability adapters. Ollama is the local default; external providers are optional and require explicit scoped consent. A ChatGPT or Codex connection does not imply access to normal ChatGPT conversation history or account memory. The exchange bridge uses a versioned manifest, transcript range and hash, base revision, and idempotent change IDs.

## Security and operations

Local content is not sent automatically. Workspace isolation is enforced server-side. Imported document text is data, never tool authorization or system instruction. The local API binds to loopback and validates origin and requests. File ingestion constrains type, size, and paths. Secrets never enter logs or exports. Agent permissions default to observe/propose; sensitive canonical changes require explicit approval and all writes pass the command gateway.

Backup and AI export are different formats. Backup preserves sources, canonical data, history, branches, settings, conversations, and a version manifest; indexes and caches may be rebuilt. Restore equivalence must be verified on a new path. The Windows package must work without a separately installed Python runtime before release.

## Runtime baseline and validation status

The planned desktop stack is React/TypeScript with Tauri 2 and a Python/FastAPI sidecar. SQLite with FTS5 is the canonical store; Cytoscape.js is the primary graph view; Docling is the primary document-ingestion candidate; Ollama is the local model default.

This is a design baseline, not evidence of implemented or packaged behavior. Sidecar packaging, target hardware, model quality, provider access, and each conditional dependency require practical verification before release.
