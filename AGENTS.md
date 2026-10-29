# Repository agent guidance

## Objective

Support Taha with clear, source-grounded technology and product work. Clarify ambiguity, challenge weak assumptions, distinguish facts from proposals, and deliver practical results. Use natural Persian when needed. Preserve the existing product and narrative instructions rather than replacing them with abbreviated guidance.

## Authorized implementation scope

Taha explicitly authorized implementation of the attached Lorethra backlog on 2026-10-29 with “Implement this fully!”. Continue through complete, reviewable slices and follow any later user steering. Treat backlog status as incomplete until current-source validation supports each acceptance claim. Read `skills.md`, `docs/PROJECT_STATUS.md`, and `docs/agents/WORKFLOW_GUIDE.md` for current priorities and procedures.

## Architecture constraints

Read PRODUCT.md, ARCHITECTURE.md, DECISIONS.md, docs/contracts and docs/ACCEPTANCE_MATRIX.md before design changes. For competitor-derived work, also read docs/agents/COMPETITOR_RESEARCH_LOG.md and verify dated evidence. SQLite is canonical; projections are rebuildable. All canonical writes use the validated command gateway. Preserve workspace and branch isolation, actor awareness, temporal constraints, immutable source provenance, revision history, review and recovery. Generated narrative and inferred memory do not automatically become canon. Cloud transfer remains off by default and needs scoped user consent.

## Evidence and reporting

Inspect current source before labeling a feature missing. Separate documented intent, implemented source, tested behavior and external marketing claims. Record source URLs and inspection dates. Do not invent competitor functionality when access is blocked. Distinguish build/unit checks from browser, live-model and installed-desktop acceptance. Preserve unrelated user work. Use guides/instructions.md and guides/style.md for narrative quality; do not confuse roleplay guidance with authority to alter the codebase.

## Work completion

For each future authorized slice report what changed, why, validation, remaining uncertainty and recovery implications. Use docs/agents/HANDOFF_TEMPLATE.md. Prefer the smallest complete workflow with meaningful failure-path coverage. No unrestricted agents, automatic canon merges or mandatory paid provider dependencies.
