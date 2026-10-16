# Troubleshooting

## PowerShell says scripts are disabled

Open PowerShell in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\START.ps1
```

This bypass applies to this launch only; it does not change the machine’s execution policy.

## Node.js is missing or too old

Install Node.js 22.14 or newer, reopen PowerShell, and run `node --version`. The app uses Node’s built-in SQLite module and has no npm package dependencies.

The installed Windows setup includes its own Node.js runtime, so Node.js is needed only for running from source or building a new installer.

## Build or install the Windows app

Run `npm run build:windows` from the repository folder inside WSL. The distro needs Node.js and NSIS (`sudo apt update && sudo apt install nsis` on Ubuntu), and Windows Node.js 22.14 or newer must be installed. If the Windows runtime is in another location, set `STORY_STUDIO_WINDOWS_NODE` to its WSL-mounted `node.exe` path. The output is an unsigned per-user `.exe`; Windows may show an unknown-publisher or SmartScreen notice. Installing it does not need administrator access. Use `npm run build:windows -- --install` to open the setup after building.

The app stores data separately from its installed files in `%LOCALAPPDATA%\TheTimelessSovereign`. Installing an update or uninstalling the app does not remove that data. Make a backup before manually deleting the data folder.

## Updates are not available

The update check reads the latest public stable release from this repository’s GitHub releases. No public release is published yet if the app reports that no release is available. A future release must include an installer named `The-Timeless-Sovereign-Setup-<version>.exe`. Download and run each new installer to update; the app does not install updates automatically.

## The page does not open, or port 4317 is already in use

The app prints its local address when it starts. If another app owns port 4317, close it or choose a different port before launching:

```powershell
$env:STORY_STUDIO_PORT = '4318'
& .\START.ps1
```

Use the printed `http://127.0.0.1:<port>/` address. The app binds to loopback only.

## Codex app-server executable was not found

The app checks `PATH` and the standard per-user Codex installation at `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe`. Install the Codex desktop/CLI app and restart Story Studio. If your installation is elsewhere, set its path before launching:

```powershell
$env:CODEX_EXECUTABLE = 'C:\full\path\to\codex.exe'
& .\START.ps1
```

The app uses Codex app-server. It does not scrape browser sessions, use private ChatGPT cookies, or accept an API key as a fallback.

## Import a ChatGPT conversation JSON

Use **Import a story project** to import a native Story Studio project export or create a new project from a ChatGPT conversation JSON file. Use **Import chat archive** to add Markdown or ChatGPT JSON messages to an existing project. A JSON chat import retains the original file, prompt/response message text, order, and valid source timestamps. It does not contain or import sign-in credentials.

## Sign-in is denied, unavailable, or reports missing authorization

Check the exact connection message in Settings. Complete Sign in with ChatGPT from the app and accept the requested access. Eligibility, available models, and usage limits depend on the account and plan. A denied or ineligible authorization leaves story generation disconnected; saved local messages remain available. Do not paste access tokens into the browser or configuration files.

If a credential error appears, use **Disconnect**, close the app, restart it, and try the official sign-in flow again. Credentials are stored using Windows DPAPI in the local data folder. If Windows cannot unlock that record, local transcript access remains available while generation stays disconnected.

## A reply failed or was interrupted

The user message is saved before Codex starts. Any partial assistant reply is retained and marked interrupted if the app closes mid-stream. Reopen the chat to inspect the transcript, then send a new message to continue. A generation failure does not erase the source record.

## Memory is pending or has an error

Continuity indexing is a separate job from saving the conversation. Pending/error status means the raw transcript is still stored. Connect Codex, use the visible retry action, and check status again. If a source citation is invalid or unsupported, the indexer rejects it rather than silently attaching it to another message.

## Restore or database integrity issue

Before restoring, download a full backup or copy the entire local data directory while the app is stopped. Restore from Settings creates a pre-restore database snapshot, then replaces the story database. The protected sign-in credentials are stored separately and are not part of project exports or database backups.

If the app reports a database integrity problem, stop the app and preserve a copy of the full data directory before trying a restore. Do not delete the database or backup folder until the story record has been recovered.

## Change or locate local data

By default, app data is at `%LOCALAPPDATA%\TheTimelessSovereign`. Set `STORY_STUDIO_DATA_DIR` before launch to use another local folder. The folder contains SQLite story data, backups, an isolated Codex home, and protected credential files; do not share it or include it in project exports.

## Verification limits

The Windows DPAPI credential-storage path and installed app-server startup/thread handshake were exercised locally. The app-server handshake used a placeholder token and did not generate a model response. The Sign in with ChatGPT callback was tested with a local mock identity provider; no real account authorization, eligibility check, OAuth exchange, refresh, or ChatGPT-plan inference was performed as part of building this app.
