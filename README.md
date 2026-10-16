# The Timeless Sovereign Story Studio

A Windows-local, chat-focused story writing app. Story messages, branches, source-linked continuity, and audit history are saved in SQLite on this PC. Story generation uses the Codex app-server with Sign in with ChatGPT; there is no API-key billing fallback.

## Start the app

Requirements:

- Windows 10 or 11.
- Node.js 22.14 or newer (`node:sqlite` is experimental in this Node release; the app suppresses that warning during normal launch).
- Codex CLI installed and available as `codex.exe` on `PATH`. If it is installed elsewhere, set `CODEX_EXECUTABLE` to its full path.
- A ChatGPT account eligible to use Sign in with ChatGPT for Codex app-server. Availability and usage limits depend on the account and plan; this app does not provide a separate allowance.

Double-click `START.ps1`, or run it from PowerShell. The app listens only on `127.0.0.1:4317` and opens the local page in your browser. To stop it, close the PowerShell window or press Ctrl+C.

For a manual launch from this folder:

```powershell
npm start
```

Optional environment settings:

- `STORY_STUDIO_PORT` changes the local port (default `4317`).
- `STORY_STUDIO_DATA_DIR` changes the local story-data directory (default `%LOCALAPPDATA%\TheTimelessSovereign`). Keep this on a local disk; do not point it at a shared or synced folder while the database is open.
- `STORY_STUDIO_OPEN_BROWSER=0` prevents automatic browser launch.
- `CODEX_EXECUTABLE` sets the full path to `codex.exe` if it is not on `PATH`.

## Connect Codex

Choose **Sign in with ChatGPT** in the app and complete the official browser sign-in. Tokens are stored separately in Windows DPAPI-protected files under the local data directory; the browser does not receive tokens. The app-server uses an isolated empty workspace, disables non-chat capabilities, and uses a read-only sandbox. If sign-in is denied, unavailable, or missing required scopes, the app stays disconnected and still saves your story turns locally. It never switches to API-key billing or another model provider.

The story database and project exports do not contain credentials. Back up the whole local data directory only to a location you control; it contains protected authorization records as well as local app state.

## Use projects, chats, and branches

- Each project has its own instructions, style, canon, and story threads.
- New chats in the same project retrieve shared project and branch continuity.
- A branch starts at its fork point and develops an independent timeline. Later events on the main branch are not visible to it.
- The Narrative view is designed for reading; Transcript shows the conventional saved message sequence. Search covers the full saved conversation. Persian and Arabic text is detected and rendered right-to-left.
- Every user turn is saved before generation begins. Assistant output is saved as it streams. If generation fails or the app closes, the source messages remain and interrupted/pending work is visible for recovery.
- Continuity indexing runs separately. A pending/error badge does not mean the transcript was lost; use **Retry memory processing** when available.

The existing `Histories` and `Images` folders are left untouched. Import a Markdown chat archive from the app to bring recognized turns into a project. The original Markdown file is retained in the local story database.

## Commands

Commands are handled locally and do not advance the fictional scene. Their text and the app’s response are retained in the transcript.

| Command | Use |
| --- | --- |
| `/meta <note>` | Save an out-of-story instruction for the next response on this branch. |
| `/pause` / `/resume` | Pause or resume story generation in this chat. |
| `/status` | Show the scene, characters, rules, open threads, and indexing status. |
| `/recap` | Show source-backed current canon, uncertain claims, and recent raw turns. |
| `/character <name>` | Show a recorded character profile. |
| `/character add <name> field="value" ...` | Add a sourced profile. Fields: `aliases`, `role`, `location`, `goals`, `condition`, `knowledge`, `injuries`, `possessions`, `relationships`, `secrets`. |
| `/character set <name> field="value" ...` | Update a profile while preserving audit history. |
| `/scene show` | Inspect the recorded current scene. |
| `/scene set location="..." time="..." participants="..." conditions="..."` | Correct the scene state for this branch. |
| `/style <preferences>` | Set project style preferences. `/style` shows the current preferences. |
| `/retcon <record-id> -- <correction>` | Supersede a continuity record with a sourced correction; the earlier record remains in history. |
| `/checkpoint` | Create a portable, source-linked checkpoint for this branch. |

Invalid or incomplete command arguments produce an explanation and do not become story dialogue.

## Backups, export, and deletion

- **Export this project** downloads complete messages, branches, source-linked ledger records, corrections, and audit history. OAuth credentials are excluded.
- **Create local backup** makes a consistent SQLite backup under the local data directory’s `backups` folder. **Download full backup** downloads the complete database snapshot; keep it private because it includes all projects and archives.
- **Restore from backup** replaces the current story database after creating a pre-restore snapshot. A restore does not replace the protected credential store.
- Project deletion requires typing the project name and `DELETE PROJECT`. It removes that project’s chats, branches, messages, ledger, audit history, checkpoints, and imported archives from the local database.

## Verify

Run `npm test` to exercise storage recovery, commands, branch and project isolation, continuity retrieval and citation validation, corrections, import/export, OAuth validation and failure states, Windows DPAPI storage, app-server protocol handling, and local API security behavior. Tests use temporary databases and mock OAuth/app-server turns; they do not sign into a real account or generate a story with ChatGPT.

## Project files

- `ARCHITECTURE.md` records the implementation and protocol decisions.
- `TROUBLESHOOTING.md` covers common startup, connection, and recovery issues.
- `START.ps1` launches the local app on Windows.
