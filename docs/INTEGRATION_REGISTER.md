# Integration and Reuse Register

Frameworks and sibling projects are candidates until their actual code, interfaces, tests, Windows support, licensing, and maintenance costs are examined. Canonical data must remain independent of every candidate.

| Candidate | Intended role | Current decision | Evidence still required |
|---|---|---|---|
| SQLite + FTS5 | Canonical storage and text search | In use through schema v10; story worlds, pinned adventures, RPG sheets, deterministic checks, and reviewed proposals use canonical SQLite rows | RPG route/browser acceptance, scale, and separate-device recovery tests |
| FastAPI | Local application API | Authenticated loopback adapter; source, Journal, story, extraction, scenario, exchange, backup, restore, and search-projection routes are tested; RPG routes are added | RPG route tests in a socket-enabled environment; packaged Tauri token-channel end-to-end test |
| React + TypeScript | Desktop interface | Selected by baseline | Build and accessibility validation |
| Tauri 2 | Windows shell and sidecar | Shell scaffold; standalone sidecar built and token-smoke-tested | Compile GUI host, clean-machine package, lifecycle test |
| Ollama | Local model runtime | Loopback model discovery/chat adapter implemented; live service not available in validation environment | Hardware, real-model behavior, Persian/English benchmark |
| Sign in with ChatGPT DevKit | Optional plan-eligible Responses provider | Not adopted: as checked 2026-10-23, the DevKit code is under a noncommercial license, so it cannot be shipped as part of the planned Apache-2.0 product; evaluate an independent implementation against current eligibility, OAuth, credential-storage, and terms requirements | [DevKit license](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/LICENSE); [open-source app eligibility](https://developers.openai.com/siwc/token-sharing-open-source); independent implementation and Windows credential vault review; eligible-account integration test |
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
