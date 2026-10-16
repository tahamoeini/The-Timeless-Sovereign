# Architecture: The Timeless Sovereign Story Studio

## Decisions

- Build a Windows-local browser app with Node.js 22.14, the built-in HTTP server, native `node:sqlite`, and plain HTML/CSS/JavaScript. This avoids a package install and uses the runtime already present. Node's SQLite module is experimental in this runtime, so schema migrations, transactions, integrity checks, and recovery tests are required.
- Offer a neutral ChatGPT-inspired light/dark/system palette. Store the selected appearance in SQLite `app_settings`, not browser storage, so it survives browser-profile changes and app upgrades.
- Bind the UI and API to `127.0.0.1` only. Keep the SQLite database, backups, isolated Codex home, and protected credentials under `%LOCALAPPDATA%\TheTimelessSovereign`; the repository contains only source and documentation.
- Treat SQLite raw messages as the permanent story record. Project, branch, thread, message, ledger, audit, and indexing-job records are linked by stable IDs. FTS indexes messages without changing them. Ledger corrections append a new sourced record and audit row.
- Keep branches separate by project and branch ID, with a fork point and an app-server `thread/fork` where supported. All ledger retrieval and writes are scoped to the selected project and branch.
- Parse slash commands in the local app before model submission. Inspection and continuity commands are recorded and handled locally; only ordinary story messages start an app-server turn.
- Before each narrative turn, assemble project instructions, style, current scene, branch-local canon and knowledge boundaries, relevant ledger/search hits with message IDs, recent raw thread turns, and the current user message. Retrieval is bounded; the full archive is searched locally and never sent wholesale.
- Use the documented Codex app-server JSONL protocol over a child-process stdio pipe. Start/resume durable Codex threads, stream deltas, interrupt on cancel, and persist the local user message and pending index job before starting generation. Disable shell, code, web, MCP, plugin, skill, and other non-chat features; start with an empty app-owned working directory and a read-only sandbox. If startup cannot apply those restrictions, do not submit story content.
- Resolve Codex from `CODEX_EXECUTABLE`, `PATH`, or the standard `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe` per-user installation.
- Package the local server, static UI, and Node runtime with a per-user Inno Setup installer. The installer lives under `%LOCALAPPDATA%\Programs`; story data remains under `%LOCALAPPDATA%\TheTimelessSovereign` and is never installed or uninstalled with app files. Keep the same Inno `AppId` across releases.
- Check updates against the repository's public GitHub Releases API. Require an HTTPS GitHub release page and the exact installer asset name; show a download link and optional SHA-256 digest. The user runs the unsigned installer to update, and the app never silently executes a downloaded file.
- Implement Sign in with ChatGPT using the official dynamic-client loopback OAuth flow: fresh state, nonce, PKCE S256, exact callback URI, issued client ID, verified ID token/JWKS, and granted-scope checks. Keep rotating tokens in Windows DPAPI-protected credential slots, pass only the access token through the app-server child environment, and never fall back to API-key billing.

## Local data and security

- Source code and the existing `Histories` and `Images` folders stay in the workspace. Story data lives under the user's local application data directory and is not committed or included in project exports.
- Every DB migration runs transactionally. Writes use foreign keys and WAL; backups use a consistent SQLite snapshot. Startup and explicit maintenance check SQLite integrity.
- The local HTTP server rejects non-loopback hosts, cross-origin mutations, and unrecognized routes. The browser uses same-origin requests, a restrictive content security policy, and text-only rendering for saved story content.
- Project export contains the complete messages, ledger, source links, corrections, preferences, and thread/branch metadata. It never contains OAuth credentials. Import creates fresh local IDs and remaps internal references.
- The Windows build uses the installed Node.js executable as a private runtime and contains no story database or credentials. Unsigned setup files may trigger Windows unknown-publisher or SmartScreen notices.

## Protocol references

- [Codex app-server protocol and lifecycle](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Sign in with ChatGPT registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Sign in with ChatGPT sessions and token refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Codex app-server with ChatGPT-plan OAuth](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

## Verification boundary

The installed executable is Codex CLI 0.162.0-alpha.17.2. Its generated v2 JSON Schema was inspected before implementation and confirms `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/interrupt`, text `UserInput`, `sandbox`, `sandboxPolicy`, and the streaming notification shapes used by the client. The app-server `initialize` and ephemeral `thread/start` handshake succeeded locally with a placeholder token and no model turn. The Windows DPAPI storage path was exercised locally. Browser smoke verified local save and search while disconnected. OAuth was tested with a local mock identity provider only; no real account authorization, eligibility check, provider token exchange/refresh, or ChatGPT-plan inference has been performed.
