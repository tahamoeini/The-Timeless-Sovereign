#!/usr/bin/env bash
set -euo pipefail

install_after_build=0
case "${1:-}" in
  "") ;;
  --install) install_after_build=1 ;;
  *) printf 'Usage: npm run build:windows [-- --install]\n' >&2; exit 2 ;;
esac

if [[ "$(uname -s)" != Linux* ]] || ! grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  printf 'Run this build inside WSL. It creates the Windows installer with NSIS from the Linux side.\n' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
build_root="$repo_root/dist/windows"
mkdir -p "$build_root"
build_root_real="$(realpath "$build_root")"
if [[ "$build_root_real" != "$repo_root/dist/windows" || -L "$build_root" ]]; then
  printf 'Refusing to build outside the repository dist/windows directory.\n' >&2
  exit 1
fi

package_version="$(node -p "require('./package.json').version")"
if [[ ! "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  printf 'package.json must contain a semantic version such as 1.2.0.\n' >&2
  exit 1
fi

windows_node="${STORY_STUDIO_WINDOWS_NODE:-}"
if [[ -z "$windows_node" ]]; then
  for candidate in '/mnt/c/Program Files/nodejs/node.exe' '/mnt/c/Program Files (x86)/nodejs/node.exe'; do
    if [[ -f "$candidate" ]]; then windows_node="$candidate"; break; fi
  done
fi
if [[ -z "$windows_node" || ! -f "$windows_node" ]]; then
  printf 'Windows Node.js 22.14+ was not found. Set STORY_STUDIO_WINDOWS_NODE to its mounted node.exe path.\n' >&2
  exit 1
fi
windows_node_version="$("$windows_node" --version 2>/dev/null || true)"
if [[ ! "$windows_node_version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  printf 'Could not read the Windows Node.js version at %s.\n' "$windows_node" >&2
  exit 1
fi
node_major="${BASH_REMATCH[1]}"
node_minor="${BASH_REMATCH[2]}"
if (( node_major < 22 || (node_major == 22 && node_minor < 14) )); then
  printf 'Windows Node.js 22.14 or newer is required; found %s.\n' "$windows_node_version" >&2
  exit 1
fi

if ! command -v makensis >/dev/null 2>&1; then
  printf 'NSIS is not installed in WSL. On Ubuntu, install it with: sudo apt update && sudo apt install nsis\n' >&2
  exit 1
fi

rm -rf -- "$build_root/payload"
payload="$build_root/payload"
app_root="$payload/app"
mkdir -p "$app_root/runtime"
cp -a "$repo_root/src" "$repo_root/public" "$app_root/"
cp "$repo_root/package.json" "$repo_root/README.md" "$repo_root/TROUBLESHOOTING.md" "$app_root/"
cp "$windows_node" "$app_root/runtime/node.exe"
cp "$repo_root/scripts/windows-launch-server.mjs" "$app_root/runtime/launch-server.mjs"
windows_node_dir="$(dirname "$windows_node")"
for license in "$windows_node_dir/LICENSE" "$windows_node_dir/LICENSE.txt"; do
  if [[ -f "$license" ]]; then cp "$license" "$app_root/runtime/Node-LICENSE.txt"; break; fi
done

for source_file in "$app_root/src/server.mjs" "$app_root/runtime/launch-server.mjs"; do
  windows_source_file="$(wslpath -w "$source_file")"
  if ! "$windows_node" --check "$windows_source_file"; then
    printf 'Windows Node.js could not validate the packaged source: %s\n' "$source_file" >&2
    exit 1
  fi
done

cat > "$payload/Launch-Story-Studio.vbs" <<'VBS'
Option Explicit
Dim shell, files, installRoot, appRoot, nodePath, launcherPath, serverPath, appUrl
Dim probe, attempt, localAppData, logDirectory, launcherLogPath, serverLogPath, logStream
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
installRoot = files.GetParentFolderName(WScript.ScriptFullName)
appRoot = files.BuildPath(installRoot, "app")
nodePath = files.BuildPath(appRoot, "runtime\node.exe")
launcherPath = files.BuildPath(appRoot, "runtime\launch-server.mjs")
serverPath = files.BuildPath(appRoot, "src\server.mjs")
localAppData = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
If localAppData = "%LOCALAPPDATA%" Then localAppData = shell.ExpandEnvironmentStrings("%TEMP%")
logDirectory = files.BuildPath(localAppData, "TheTimelessSovereign\logs")
On Error Resume Next
If Not files.FolderExists(files.BuildPath(localAppData, "TheTimelessSovereign")) Then files.CreateFolder files.BuildPath(localAppData, "TheTimelessSovereign")
If Not files.FolderExists(logDirectory) Then files.CreateFolder logDirectory
If Err.Number <> 0 Then
  Err.Clear
  logDirectory = shell.ExpandEnvironmentStrings("%TEMP%")
End If
launcherLogPath = files.BuildPath(logDirectory, "Story-Studio-launcher.log")
serverLogPath = files.BuildPath(logDirectory, "Story-Studio-startup.log")
Set logStream = files.CreateTextFile(launcherLogPath, True, True)
If Err.Number = 0 Then
  logStream.WriteLine Now & " Launch requested from " & installRoot
  logStream.Close
End If
Err.Clear

If Not files.FileExists(nodePath) Then
  RecordLaunchError "Bundled Node.js runtime is missing: " & nodePath
  ShowLaunchFailure "The bundled Node.js runtime is missing."
  WScript.Quit 1
End If
If Not files.FileExists(launcherPath) Or Not files.FileExists(serverPath) Then
  RecordLaunchError "The installed launcher or server file is missing."
  ShowLaunchFailure "The installed app files are incomplete. Run the installer again."
  WScript.Quit 1
End If

appUrl = "http://127.0.0.1:4317/"
shell.Environment("Process")("STORY_STUDIO_PORT") = "4317"
shell.Environment("Process")("STORY_STUDIO_OPEN_BROWSER") = "0"
shell.CurrentDirectory = appRoot

Set probe = CreateObject("WinHttp.WinHttpRequest.5.1")
probe.SetTimeouts 300, 300, 300, 300
probe.Open "GET", appUrl & "api/bootstrap", False
probe.Send
If Err.Number = 0 And probe.Status = 200 Then
  If InStr(1, probe.ResponseText, """csrfToken""", vbTextCompare) > 0 And InStr(1, probe.ResponseText, """appVersion""", vbTextCompare) > 0 Then
    shell.Run appUrl, 1, False
    WScript.Quit 0
  End If
  RecordLaunchError "Port 4317 returned HTTP 200, but the response was not Story Studio."
  ShowLaunchFailure "Another service is using port 4317. Close it, then launch Story Studio again."
  WScript.Quit 1
ElseIf Err.Number = 0 Then
  RecordLaunchError "Port 4317 is occupied and returned HTTP " & probe.Status & "."
  ShowLaunchFailure "Another service is using port 4317. Close it, then launch Story Studio again."
  WScript.Quit 1
End If
Err.Clear

shell.Run """" & nodePath & """ --disable-warning=ExperimentalWarning """ & launcherPath & """ """ & serverPath & """ """ & serverLogPath & """", 0, False
If Err.Number <> 0 Then
  RecordLaunchError "Windows could not launch the bundled Node.js runtime: " & Err.Description
  ShowLaunchFailure "Windows could not launch the bundled Node.js runtime."
  WScript.Quit 1
End If
For attempt = 1 To 60
  WScript.Sleep 500
  Err.Clear
  Set probe = CreateObject("WinHttp.WinHttpRequest.5.1")
  probe.SetTimeouts 300, 300, 300, 300
  probe.Open "GET", appUrl & "api/bootstrap", False
  probe.Send
  If Err.Number = 0 And probe.Status = 200 Then
    If InStr(1, probe.ResponseText, """csrfToken""", vbTextCompare) > 0 And InStr(1, probe.ResponseText, """appVersion""", vbTextCompare) > 0 Then
      shell.Run appUrl, 1, False
      WScript.Quit 0
    End If
  End If
Next
RecordLaunchError "Story Studio did not become ready within 30 seconds."
ShowLaunchFailure "Story Studio did not become ready within 30 seconds."

Sub RecordLaunchError(message)
  On Error Resume Next
  Dim errorStream
  Set errorStream = files.OpenTextFile(launcherLogPath, 8, True, -1)
  If Err.Number = 0 Then
    errorStream.WriteLine Now & " " & message
    errorStream.Close
  End If
  Err.Clear
End Sub

Sub ShowLaunchFailure(message)
  MsgBox message & vbCrLf & vbCrLf & "Review these logs for the startup error:" & vbCrLf & launcherLogPath & vbCrLf & serverLogPath, vbExclamation, "The Timeless Sovereign Story Studio"
End Sub
VBS

cat > "$payload/Stop-Story-Studio.vbs" <<'VBS'
Option Explicit
Dim request, expression, matches, serverPath, service, processes, process, found, attempt
On Error Resume Next
serverPath = ""
If WScript.Arguments.Count > 0 Then serverPath = WScript.Arguments(0)
Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
If Err.Number <> 0 Then
  MsgBox "Story Studio could not verify its local server. Close it before installing the update.", vbExclamation, "Story Studio could not close"
  WScript.Quit 1
End If
request.SetTimeouts 500, 500, 500, 500
request.Open "GET", "http://127.0.0.1:4317/api/bootstrap", False
request.Send
If Err.Number = 0 Then
  If request.Status <> 200 Then
    MsgBox "Another service is using the Story Studio address. Close it before installing the update.", vbExclamation, "Story Studio could not close"
    WScript.Quit 1
  End If
  Set expression = New RegExp
  expression.Pattern = """csrfToken""\s*:\s*""([^""]+)"""
  Set matches = expression.Execute(request.ResponseText)
  If matches.Count = 0 Then
    MsgBox "Story Studio could not verify its local server. Close it before installing the update.", vbExclamation, "Story Studio could not close"
    WScript.Quit 1
  End If
  request.Open "POST", "http://127.0.0.1:4317/api/app/shutdown", False
  request.SetRequestHeader "Origin", "http://127.0.0.1:4317"
  request.SetRequestHeader "X-CSRF-Token", matches(0).SubMatches(0)
  request.SetRequestHeader "Content-Type", "application/json"
  request.Send "{}"
  If Err.Number <> 0 Then
    MsgBox "Story Studio could not be stopped safely. Close it before installing the update.", vbExclamation, "Story Studio could not close"
    WScript.Quit 1
  End If
  If request.Status = 409 Then
    MsgBox "A story response is still running. Wait for it to finish, then run the installer again.", vbInformation, "Story Studio is busy"
    WScript.Quit 1
  End If
  If request.Status <> 200 Then
    MsgBox "Story Studio could not be stopped safely. Close it before installing the update.", vbExclamation, "Story Studio could not close"
    WScript.Quit 1
  End If
  For attempt = 1 To 120
    WScript.Sleep 250
    Err.Clear
    Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
    request.SetTimeouts 500, 500, 500, 500
    request.Open "GET", "http://127.0.0.1:4317/api/bootstrap", False
    request.Send
    If Err.Number <> 0 Then WScript.Quit 0
    If request.Status <> 200 And request.Status <> 503 Then
      MsgBox "Story Studio stopped responding unexpectedly. Close it and try again.", vbExclamation, "Story Studio could not close"
      WScript.Quit 1
    End If
  Next
  MsgBox "Story Studio did not close in time. Close it and try again.", vbExclamation, "Story Studio could not close"
  WScript.Quit 1
Else
  Err.Clear
  Set service = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then
    MsgBox "Story Studio could not verify whether its local server is running. Close it before installing the update.", vbExclamation, "Story Studio could not close"
    WScript.Quit 1
  End If
  Set processes = service.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
  If Err.Number <> 0 Then
    MsgBox "Story Studio could not verify whether its local server is running. Close it before installing the update.", vbExclamation, "Story Studio could not close"
    WScript.Quit 1
  End If
  found = False
  For Each process In processes
    If InStr(1, LCase(CStr(process.CommandLine)), LCase(serverPath), vbTextCompare) > 0 Then found = True
  Next
  If found Then
    MsgBox "Story Studio is still running but is not responding. Close the app and try again.", vbExclamation, "Story Studio could not close"
    WScript.Quit 1
  End If
End If
WScript.Quit 0
VBS

installer="$build_root/The-Timeless-Sovereign-Setup-$package_version.exe"
(
  cd "$repo_root"
  makensis -V3 "-DAPP_VERSION=$package_version" scripts/windows-installer.nsi
)
if [[ ! -s "$installer" ]]; then
  printf 'NSIS did not create the expected installer: %s\n' "$installer" >&2
  exit 1
fi

printf 'Created unsigned per-user installer: %s\n' "$installer"
printf 'SHA-256: '
sha256sum "$installer" | awk '{print $1}'
printf 'The SQLite database and protected credentials remain under %%LOCALAPPDATA%%\\TheTimelessSovereign.\n'

if (( install_after_build )); then
  windows_installer="$(wslpath -w "$installer")"
  cmd.exe /c start "" "$windows_installer"
fi
