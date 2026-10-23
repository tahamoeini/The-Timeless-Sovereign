# Exchange Protocol

The external conversation bridge is an immutable, branch-scoped archive and proposal channel. It never imports transcript text as a story turn or writes claims, events, relationships, or other canonical facts. Every later change must use a separate reviewed command against the current branch revision.

## `lke.exchange.v1`

Each JSON package identifies one segment of an external transcript. Use the same stable `transcript_id` for every segment from one external conversation; assign a new ID for a different conversation. `exchange_id` identifies one imported package. Turn numbers start at 1, are ordered within that transcript, and must be contiguous inside each package. `transcript_total_turns` declares the latest known end of the external transcript so gaps at its beginning, middle, or end can be reported. When a conversation grows, a newer package may declare a larger total.

```json
{
  "protocol": "lke.exchange.v1",
  "workspace_id": "workspace_001",
  "branch_id": "main",
  "base_revision": 42,
  "exchange_id": "exchange_009",
  "transcript_id": "external-chat-2026-01",
  "context_manifest_id": "context_118",
  "context_manifest": {
    "protocol": "lke.context.v1",
    "manifest_id": "context_118",
    "workspace_id": "workspace_001",
    "branch_id": "main",
    "base_revision": 42,
    "actor": {"entity_id": "aria", "label": "Aria", "entity_type": "character"},
    "included": [],
    "excluded": []
  },
  "transcript_range": {"from_turn": 51, "to_turn": 52},
  "transcript_total_turns": 58,
  "transcript_hash": "sha256:...",
  "turns": [
    {"turn_number": 51, "messages": [
      {"role": "user", "content": "Continue the scene."},
      {"role": "assistant", "content": "Aria waits by the archive."}
    ]},
    {"turn_number": 52, "messages": [
      {"role": "user", "content": "Open the door."},
      {"role": "assistant", "content": "The lock turns."}
    ]}
  ],
  "proposed_change_ids": ["change_101", "change_102"]
}
```

`transcript_hash` is `sha256:` followed by the lowercase SHA-256 hex digest of the UTF-8 bytes of the `turns` array serialized as canonical JSON: recursively sort object keys, preserve array order and Unicode characters, and emit no insignificant whitespace. The gateway verifies the supplied hash. The browser import panel can calculate it when the field is omitted.

The gateway validates protocol and workspace/branch identity, the context manifest's declared protocol, ID, workspace, branch, and revision, a non-future base revision, one-based turn range and declared total, contiguous turn numbering, message roles and sizes, transcript hash, and unique proposal references. The manifest is untrusted imported data; these checks do not cryptographically authenticate its origin. Each turn needs at least one user and one assistant message. Packages are limited to 10 MiB, 500 turns, 50 messages per turn, and 20,000 characters per message.

## Continuity, duplicates, and stale context

- A stable `transcript_id` groups imported segments. The importer checks coverage from turn 1 through the largest declared `transcript_total_turns` and reports missing ranges, including known missing prefixes and tails. Conflicting text for overlapping turn numbers under one transcript ID is rejected. Identical overlapping turns are allowed.
- Re-importing the same transcript segment under the same transcript ID, hash, and declared total is a no-op. A changed known transcript end is preserved as a distinct immutable package so tail gaps can be surfaced. Reusing an `exchange_id` with different text or context is a conflict. Identical text belonging to a different transcript ID remains a separate transcript.
- A base revision ahead of the selected branch is rejected. An older base revision is retained and marked stale. The UI shows the imported context snapshot alongside the current branch revision so the user can review what changed after export.
- Imported transcript text is untrusted. A gap or stale context remains review-only; the importer never creates canonical events or claims. Proposal references are labels only; they are not executable changes.
- Exchanges are immutable branch records. Branch creation snapshots them, and explicit fast-forward promotion preserves their provenance.

Schema v8 preserves existing v7 exchange rows and initializes their known transcript end to the last turn number in each saved segment. New packages use one-based turn numbering.

## Context-only export and backups

Story Studio can save the current actor-aware context as a local `lke.context-export.v1` JSON package. It contains the export time, workspace, branch, base revision, and exact `lke.context.v1` manifest, including included facts and exclusion reasons. The preview shows included facts and the exclusion count before saving; the downloaded package preserves the full details for inspection. The package does not include full source text or the story transcript. The user chooses separately whether to share it.

Transcript export and redaction controls are not implemented. Full backup is a separate format that includes source content, canonical data, revisions, branch snapshots, settings, conversations, external exchanges, and a versioned integrity manifest. Backup/restore is implemented; a separate-device restore drill remains pending.
