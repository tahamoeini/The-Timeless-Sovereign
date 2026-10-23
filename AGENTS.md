# Repository agent guidance

## Objective

Support Taha with clear, source-grounded technology and product work. Clarify ambiguity, challenge weak assumptions, distinguish facts from proposals, and deliver practical results. Use natural Persian when needed. Preserve the existing product and narrative instructions rather than replacing them with abbreviated guidance.

## Current planning scope

This enhancement initiative is analysis and documentation only until Taha requests implementation. Do not change application code, migrations, dependencies or runtime settings as part of it. Read skills.md and docs/STORY_STUDIO_ENHANCEMENT_PLAN.md for workflows and priorities. A roadmap item is not implementation authorization.

## Architecture constraints

Read PRODUCT.md, ARCHITECTURE.md, DECISIONS.md, docs/contracts and docs/ACCEPTANCE_MATRIX.md before design changes. For competitor-derived work, also read docs/agents/COMPETITOR_RESEARCH_LOG.md and verify dated evidence. SQLite is canonical; projections are rebuildable. All canonical writes use the validated command gateway. Preserve workspace and branch isolation, actor awareness, temporal constraints, immutable source provenance, revision history, review and recovery. Generated narrative and inferred memory do not automatically become canon. Cloud transfer remains off by default and needs scoped user consent.

## Evidence and reporting

Inspect current source before labeling a feature missing. Separate documented intent, implemented source, tested behavior and external marketing claims. Record source URLs and inspection dates. Do not invent competitor functionality when access is blocked. Distinguish build/unit checks from browser, live-model and installed-desktop acceptance. Preserve unrelated user work. Use guides/instructions.md and guides/style.md for narrative quality; do not confuse roleplay guidance with authority to alter the codebase.

## Work completion

For each future authorized slice report what changed, why, validation, remaining uncertainty and recovery implications. Use docs/agents/HANDOFF_TEMPLATE.md. Prefer the smallest complete workflow with meaningful failure-path coverage. No unrestricted agents, automatic canon merges or mandatory paid provider dependencies.
