# AI Provider Specification

Providers implement a narrow adapter and never own Lorethra data. The default product path is local Ollama; cloud or external providers are opt-in and require explicit consent for the exact context being sent.

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

No content leaves the device by default. Before an external story or memory request, the UI identifies the provider and asks for provider-specific consent. The authenticated API also requires a matching provider-consent value for each external request; client preference alone is not authorization. Remote context is filtered to public claims and shared, reviewed memories. Author notes, private NPC and protagonist profiles, imported MNO lorebook references, actor-scoped facts, unshared memories, and unclassified lore or threads are excluded. Consent can be revoked in Story Studio. Provider terms and billing still apply, and a hosted provider may continue processing after Lorethra closes a cancelled request.

Imported documents are untrusted content, not instructions. A model cannot authorize itself, select arbitrary files, or bypass the command gateway. Actor labels supplied by a client are not proof of authorization. Future agent execution or Safe Apply features require a separate server-side policy and review design.

## Implemented local adapter and status

The provider registry exposes local Ollama, OpenAI API, Claude API, Codex app-server, and hosted or locally served Hugging Face models. The Ollama adapter discovers local model names and sends non-streaming chat and JSON-formatted requests only to `127.0.0.1:11434`. Story generation uses revision-bound actor context, bounded recent transcript history, and command-gateway persistence. An optional public opening-scene seed is included only for the first response and is untrusted data; external use follows the same provider-specific consent and public-context rules as other world content. Provider failure, cancellation before commit, or a stale revision creates no partial turn. A retry with the same request key reuses the original result. External adapters close active HTTP responses on cancellation; Codex app-server cancellation terminates its ephemeral process. This does not prove that a hosted service stops work or billing after disconnect.

The first extraction flow supports entity and claim candidates from text sources up to 24,000 characters. It validates the strict output shape and exact source quote before recording a branch-scoped batch; each candidate remains proposed until a user explicitly reviews it.

The optional World Architect is local-Ollama-only. It receives only the world name, selected template, and user-entered creative brief. Its strict JSON draft is checked for bounded, non-empty prose, unique location names, and a starting-location reference; it does not write world records. The user can cancel generation, then must preview and explicitly apply the draft, edit the resulting fields, and save through the ordinary versioned world command. Provider failure, disconnect, or cancellation has no canonical write to roll back.

Core adapter and extraction validation use deterministic tests. Authenticated HTTP tests cover model discovery, external provider consent/redaction, cancellation before commit, extraction replay, review, and provider failure; browser acceptance uses deterministic mock Ollama responses for extraction review and story retry. No live provider was used for current acceptance, so model quality, retention policy, real cancellation/billing behavior, CPU-only performance, and Persian/English output remain unverified. Relation/event extraction, embeddings, reranking, streaming, tool use, and capability benchmarking are not implemented.

The sign-in DevKit is not bundled. Before adopting any account-linked provider SDK, recheck its current license, eligibility, terms, token renewal, and Windows credential-storage requirements. The existing Codex app-server adapter and configured API-key adapters are not evidence that another sign-in flow is supported. A standard API key adapter is not required for the v0.1 local path. No provider may write accepted knowledge directly.
