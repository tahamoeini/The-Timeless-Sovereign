# Integration and Reuse Register

Frameworks and sibling projects are candidates until their actual code, interfaces, tests, Windows support, licensing, and maintenance costs are examined. Canonical data must remain independent of every candidate.

| Candidate | Intended role | Current decision | Evidence still required |
|---|---|---|---|
| SQLite + FTS5 | Canonical storage and text search | In use in schema v1 | Migration, backup, and scale tests |
| FastAPI | Local application API | Adapter scaffold added | Install/runtime and Tauri token-channel test |
| React + TypeScript | Desktop interface | Selected by baseline | Build and accessibility validation |
| Tauri 2 | Windows shell and sidecar | Selected by baseline | Clean-machine package and sidecar lifecycle test |
| Ollama | Local model runtime | Default provider direction | Hardware, structured output, Persian/English benchmark |
| Docling | PDF/Office parsing | Optional candidate | Windows install, file safety, quality and license review |
| LangExtract | Grounded extraction | Conditional candidate | Provider/schema support and evidence benchmark |
| Cognee | Advanced extraction/retrieval | First candidate to evaluate | Role-specific benchmark, Windows packaging, license |
| Graphiti | Temporal graph retrieval | Temporal candidate | Structured-output and Windows/runtime test |
| LightRAG | Document graph retrieval | Advanced retrieval candidate | Model/resource, quality, license, and packaging test |
| sqlite-vec | Local vector projection | Conditional candidate | Pin version, Windows test, rebuild/migration test |
| Raggi | Research/source/evidence concepts | Reuse review pending | Inspect actual repository and adapter cost |
| GlyphMend | Document IR/transform concepts | Reuse review pending | Inspect actual repository, tests, and license |
| Synthora | Scenario concepts | Reuse review pending | Compare domain contracts and test coverage |
| SmartPack | Export/backup concepts | Reuse review pending | Inspect format, safety, license, and recovery tests |
| Ariadne | Desktop/bridge concepts | Reuse review pending | Inspect process boundary and platform behavior |
| Story Studio | Narrative experience concepts | Reuse review pending | Inspect code, UX, model, and migration cost |

No external project with a matching name is assumed to be one of the user's sibling projects. No repository has been merged into this reset. Record inspected commit IDs, licenses, and pass/fail results here before adopting code or a framework.
