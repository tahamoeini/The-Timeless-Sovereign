# Future validation guide

This is a test design, not a record of executed tests.

| Area | Required proof |
|---|---|
| Knowledge boundaries | Cross-workspace, branch, actor, future-time and unreviewed facts never enter authorized context, including summaries/caches |
| Memory quality | Fixed-budget relevant-fact recall and precision compared with chronological baseline; contradictory beliefs retain sources |
| Canon review | Reject causes no mutation; accept is audited/idempotent; stale revision fails safely |
| Narrative | Human rubric for agency, voice, Persian naturalness, pacing and continuity across long sessions |
| World packages | Independent sessions, hostile/invalid import, version mismatch, collision handling and round-trip recovery |
| Media | Selective regeneration, asset lineage, offline fallback, cancellation and spend ceiling |
| Publishing | RTL and mixed-script visual review; private context excluded; export preview matches actual artifact |
| Recovery | Close/reopen and restore to a separate destination preserve canonical history and asset references |

Record model/provider versions, hardware, fixture version, source revision, results and limitations. Separate deterministic context correctness from probabilistic model compliance. Never claim full desktop or live-model acceptance from simulated adapters or a successful build.
