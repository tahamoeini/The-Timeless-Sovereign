# AI Provider Specification

Providers implement a narrow adapter and never own LKE data. The default product path is local Ollama; cloud or external providers are opt-in and require explicit consent for the exact context being sent.

## Capability record

Each model/runtime registration must report provider and model identifiers, runtime version, `chat`, `structured_output`, `embeddings`, `rerank`, `tool_use`, `streaming`, `vision`, context window, hardware estimate, tested languages, and validation date. Unsupported capabilities are explicit. Changing an embedding model invalidates only the derived index.

## Adapter operations

- `health()` reports availability and runtime details without sending workspace content.
- `capabilities()` returns tested claims, not inferred support.
- `generate(request, context)` accepts a bounded request and returns text plus usage/finish metadata.
- `extract(request, source_segments)` returns schema-validated candidates with source anchors; candidates stay proposed.
- `embed(texts)` is optional and updates only rebuildable retrieval data.
- Cancellation, timeout, model unload, and provider failure must leave canonical state unchanged.

## Privacy and authority

No content leaves the device by default. Before an external call, the UI shows provider, selected source/context scope, and relevant sensitive-data warning. Imported documents are untrusted content, not instructions. A model cannot authorize itself, select arbitrary files, or bypass the command gateway. Safe Apply and sensitive actions require server-side policy and user approval; actor labels supplied by a client are not proof of authorization.

## Implemented local adapter and status

The Ollama adapter discovers local model names and sends non-streaming chat requests only to `127.0.0.1:11434`. The Story Studio route supplies a revision-bound actor context, bounds recent transcript history, and saves a successful prompt/response pair through the command gateway. Provider failure or a stale revision creates no partial turn. A retry with the same request key reuses the original result.

The API and adapter are covered by tests with a simulated provider. No live Ollama service or installed model was available during validation, so generation quality, CPU-only performance, timeout behavior against a real model, and Persian/English output remain unverified. Only chat/model discovery are implemented; structured extraction, embeddings, reranking, streaming, tool use, and capability benchmarking are not.

Codex app-server and any sign-in path must be checked against current official capabilities and terms before implementation. A standard API key adapter is not required for the v0.1 local path. No provider may write accepted knowledge directly.
