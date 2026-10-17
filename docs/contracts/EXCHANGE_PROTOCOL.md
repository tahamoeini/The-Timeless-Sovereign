# Exchange Protocol

External conversation exchange is a proposal channel, not a direct write path. The envelope is versioned and carries enough identity to find missing turns, prevent duplicate imports, and detect stale context.

```json
{
  "protocol": "lke.exchange.v1",
  "workspace_id": "workspace_001",
  "branch_id": "main",
  "base_revision": 42,
  "exchange_id": "exchange_009",
  "context_manifest_id": "context_118",
  "transcript_range": {"from_turn": 51, "to_turn": 58},
  "transcript_hash": "sha256:...",
  "proposed_change_ids": ["change_101", "change_102"]
}
```

Validate protocol version, workspace, branch, context manifest, contiguous turn sequence, range, and transcript hash. Store original turns unchanged. Deduplicate by exchange identity and transcript hash; same identity with different content is a conflict. If the current branch revision differs from `base_revision`, retain the exchange as a proposal for review and show the stale-context difference. Imported text is untrusted content. Accepting a proposed change requires a new command with a current expected revision.

Export should support privacy review and redaction without changing canonical records. Full backup is a separate format that includes source content, canonical data, revisions, branch snapshots, settings, conversations, and a versioned integrity manifest. Neither exchange import nor backup/restore is implemented yet.
