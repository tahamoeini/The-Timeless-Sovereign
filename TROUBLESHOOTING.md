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

To update, build the next version through the same WSL command and run its `The-Timeless-Sovereign-Setup-<version>.exe`. Setup replaces the installed app and leaves the local story database in place. It asks the running app to stop first. Use **Stop app** if an active reply needs to be interrupted before installing.

## Updates are not available

The update check reads the latest public stable release from this repository’s GitHub releases. No public release is published yet if the app reports that no release is available. A future release must include an installer named `The-Timeless-Sovereign-Setup-<version>.exe`. Download and run each new installer to update; the app does not install updates automatically.

## Package version did not bump on commit

Run `npm run setup:git-hooks` once in the repository. The setup points this clone's Git hooks at `.githooks`; it does not replace an existing custom hook folder. Use a conventional commit header such as `feat: add scene search` or `fix(memory): retry failed indexing`. If `package.json` has unstaged changes, stage those edits first so the hook can safely add only the version change.

## The page does not open, or a local port is already in use

The installed app uses port 4318 so it can run alongside a source-run app on port 4317. If another app owns either address, choose an unused port before launching the source-run app:

```powershell
$env:STORY_STUDIO_PORT = '4319'
& .\START.ps1
```

Use the printed `http://127.0.0.1:<port>/` address. The app binds to loopback only.

Only one app process can open a data directory. If Story Studio says the directory is already in use, close the other instance first. A lock left by a crashed process is cleared automatically the next time the app starts.

The installed launcher reuses only the server process from the same installation on port 4318. It leaves a source-run server on port 4317 alone. If the installed app does not start, the launcher shows the paths to its local logs. Open `Story-Studio-launcher.log` and `Story-Studio-startup.log` under `%LOCALAPPDATA%\TheTimelessSovereign\logs` and use the last error in `Story-Studio-startup.log` to identify the startup failure. If the logs are unavailable there, check `%TEMP%` for the same filenames.

## Codex app-server executable was not found

The app checks `PATH` and the standard per-user Codex installation at `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe`. Install the Codex desktop/CLI app and restart Story Studio. If your installation is elsewhere, set its path before launching:

```powershell
$env:CODEX_EXECUTABLE = 'C:\full\path\to\codex.exe'
& .\START.ps1
```

The app uses Codex app-server. It does not scrape browser sessions, use private ChatGPT cookies, or accept an API key as a fallback.

## Import a ChatGPT conversation JSON

Use **Import project** in the library, or on the empty welcome screen, to restore a complete Story Studio `.story.json` export or create a new project from a ChatGPT conversation JSON file. Use **Import chat archive** to add Markdown or ChatGPT JSON messages to an existing project. A JSON chat import retains the original file, prompt/response message text, order, and valid source timestamps. It does not contain or import sign-in credentials.

## Delete a conversation

Select the × beside a conversation, review the number of saved messages and dependent branches, then type the exact conversation title and `DELETE CHAT`. If it is still replying, use **Stop reply** first. Removing a chat also removes alternate branches that were forked from it; unrelated conversations stay saved. Project deletion remains a separate action in Settings.

## Stop the app quickly

Use **Stop app** in the top bar to interrupt every active reply and close Story Studio. User messages and partial assistant replies already saved remain in the local database. Close the browser tab after the app stops; start it again from the installed shortcut.

## Sign-in is denied, unavailable, or reports missing authorization

Check the exact connection message in Settings. Complete Sign in with ChatGPT from the app and accept the requested access. Eligibility, available models, and usage limits depend on the account and plan. A denied or ineligible authorization leaves story generation disconnected; saved local messages remain available. Do not paste access tokens into the browser or configuration files.

If a credential error appears, use **Disconnect**, close the app, restart it, and try the official sign-in flow again. Credentials are stored using Windows DPAPI in the local data folder. If Windows cannot unlock that record, local transcript access remains available while generation stays disconnected.

## A reply failed or was interrupted

The user message is saved before Codex starts. Any partial assistant reply is retained and marked interrupted if the app closes mid-stream. Use **Retry** on a failed or interrupted reply to try that saved user turn again without adding a duplicate; each partial attempt remains in the transcript. Draft text is saved separately while you type and returns when you reopen the conversation. A generation failure does not erase the source record.

## Memory is pending or has an error

Continuity indexing is a separate job from saving the conversation. Pending/error status means the raw transcript is still stored. Connect Codex, use the visible retry action, and check status again. If a source citation is invalid or unsupported, the indexer rejects it rather than silently attaching it to another message.

If the error says `Invalid schema for response_format` and points to `details`, the installed version has an outdated continuity schema. Update Story Studio, reopen the project, then select **Retry memory processing**. The failed records are reprocessed from their saved source messages; the transcript is not rewritten.

## Restore or database integrity issue

Settings shows the latest successful backup and any automatic backup failure. Story Studio makes one automatic SQLite snapshot per UTC day and keeps the latest 14 successful automatic snapshots. You can create a manual snapshot or restore a listed local SQLite snapshot from Settings. Restore stops and drains active replies and indexing, validates the chosen database, creates a pre-restore snapshot, then replaces the story database. The protected sign-in credentials are stored separately and are not part of project exports or backups.

If the app reports a database integrity problem, stop the app and preserve a copy of the full data directory before trying a restore. Do not delete the database or backup folder until the story record has been recovered.

## Change or locate local data

By default, app data is at `%LOCALAPPDATA%\TheTimelessSovereign`. Set `STORY_STUDIO_DATA_DIR` before launch to use another local folder. The folder contains SQLite story data, backups, an isolated Codex home, and protected credential files; do not share it or include it in project exports.

## Verification limits

The Windows DPAPI credential-storage path and installed app-server startup/thread handshake were exercised locally. The app-server handshake used a placeholder token and did not generate a model response. The Sign in with ChatGPT callback was tested with a local mock identity provider; no real account authorization, eligibility check, OAuth exchange, refresh, or ChatGPT-plan inference was performed as part of building this app.
