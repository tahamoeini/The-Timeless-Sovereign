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
Dim packagedServerState
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
Else
  Err.Clear
  logDirectory = shell.ExpandEnvironmentStrings("%TEMP%")
  launcherLogPath = files.BuildPath(logDirectory, "Story-Studio-launcher.log")
  serverLogPath = files.BuildPath(logDirectory, "Story-Studio-startup.log")
  Set logStream = files.OpenTextFile(launcherLogPath, 8, True, -1)
  If Err.Number = 0 Then
    logStream.WriteLine Now & " Launch requested from " & installRoot & " (LOCALAPPDATA log directory unavailable; using TEMP)."
    logStream.Close
  End If
End If
Err.Clear

If Not files.FileExists(nodePath) Then
  RecordLaunchEvent "Bundled Node.js runtime is missing: " & nodePath
  ShowLaunchFailure "The bundled Node.js runtime is missing."
  WScript.Quit 1
End If
If Not files.FileExists(launcherPath) Or Not files.FileExists(serverPath) Then
  RecordLaunchEvent "The installed launcher or server file is missing."
  ShowLaunchFailure "The installed app files are incomplete. Run the installer again."
  WScript.Quit 1
End If

appUrl = "http://127.0.0.1:4318/"
shell.Environment("Process")("STORY_STUDIO_PORT") = "4318"
shell.Environment("Process")("STORY_STUDIO_OPEN_BROWSER") = "0"
shell.CurrentDirectory = appRoot

Set probe = CreateObject("WinHttp.WinHttpRequest.5.1")
probe.SetTimeouts 300, 300, 300, 300
probe.Open "GET", appUrl & "api/bootstrap", False
probe.Send
If Err.Number = 0 And probe.Status = 200 Then
  If InStr(1, probe.ResponseText, """csrfToken""", vbTextCompare) > 0 And InStr(1, probe.ResponseText, """appVersion""", vbTextCompare) > 0 Then
    packagedServerState = CheckPackagedServerProcess(nodePath, serverPath)
    If packagedServerState = 0 Then
      RecordLaunchEvent "Port 4318 is serving Story Studio, but its process does not belong to this installation."
      ShowLaunchFailure "Another service is using port 4318. Close it, then launch Story Studio again."
      WScript.Quit 1
    ElseIf packagedServerState < 0 Then
      RecordLaunchEvent "Port 4318 is serving Story Studio, but Windows could not verify its process owner."
      ShowLaunchFailure "Story Studio found another server on port 4318 but could not verify its process owner. Close it, then launch again."
      WScript.Quit 1
    End If
    RecordLaunchEvent "Reusing the Story Studio server already responding on port 4318. Opening " & appUrl
    Err.Clear
    shell.Run appUrl, 1, False
    If Err.Number <> 0 Then
      RecordLaunchEvent "Windows could not open the browser: " & Err.Description
      ShowLaunchFailure "Windows could not open the browser."
      WScript.Quit 1
    End If
    RecordLaunchEvent "Browser open request accepted for the existing server."
    WScript.Quit 0
  End If
  RecordLaunchEvent "Port 4318 returned HTTP 200, but the response was not Story Studio."
  ShowLaunchFailure "Another service is using port 4318. Close it, then launch Story Studio again."
  WScript.Quit 1
ElseIf Err.Number = 0 Then
  RecordLaunchEvent "Port 4318 is occupied and returned HTTP " & probe.Status & "."
  ShowLaunchFailure "Another service is using port 4318. Close it, then launch Story Studio again."
  WScript.Quit 1
End If
If Err.Number <> 0 Then RecordLaunchEvent "No healthy server answered the initial probe; starting the packaged server. Probe detail: " & Err.Description
Err.Clear

RecordLaunchEvent "Starting the packaged server with the bundled Node.js runtime."
shell.Run """" & nodePath & """ --disable-warning=ExperimentalWarning """ & launcherPath & """ """ & serverPath & """ """ & serverLogPath & """", 0, False
If Err.Number <> 0 Then
  RecordLaunchEvent "Windows could not launch the bundled Node.js runtime: " & Err.Description
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
      RecordLaunchEvent "Packaged server is ready on port 4318. Opening " & appUrl
      Err.Clear
      shell.Run appUrl, 1, False
      If Err.Number <> 0 Then
        RecordLaunchEvent "Windows could not open the browser: " & Err.Description
        ShowLaunchFailure "Windows could not open the browser."
        WScript.Quit 1
      End If
      RecordLaunchEvent "Browser open request accepted for the packaged server."
      WScript.Quit 0
    End If
  End If
Next
RecordLaunchEvent "Story Studio did not become ready within 30 seconds."
ShowLaunchFailure "Story Studio did not become ready within 30 seconds."

Sub RecordLaunchEvent(message)
  On Error Resume Next
  Dim errorStream
  Set errorStream = files.OpenTextFile(launcherLogPath, 8, True, -1)
  If Err.Number = 0 Then
    errorStream.WriteLine Now & " " & message
    errorStream.Close
  End If
  Err.Clear
End Sub

Function CheckPackagedServerProcess(expectedNodePath, expectedServerPath)
  On Error Resume Next
  Dim netstat, outputLine, expression, matches, ownerPid
  Dim service, processes, process, processCommandLine, processSeen, found
  Err.Clear
  Set netstat = shell.Exec("cmd.exe /d /c netstat -ano -p tcp")
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  Set expression = New RegExp
  expression.IgnoreCase = True
  expression.Pattern = "^\s*TCP\s+\S+:4318\s+\S+\s+LISTENING\s+([0-9]+)"
  ownerPid = ""
  Do Until netstat.StdOut.AtEndOfStream
    outputLine = netstat.StdOut.ReadLine
    Set matches = expression.Execute(Trim(outputLine))
    If matches.Count > 0 Then
      ownerPid = matches(0).SubMatches(0)
      Exit Do
    End If
  Loop
  If Err.Number <> 0 Or ownerPid = "" Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  Set service = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  Set processes = service.ExecQuery("SELECT ExecutablePath, CommandLine FROM Win32_Process WHERE ProcessId=" & ownerPid)
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  processSeen = False
  found = False
  For Each process In processes
    If Err.Number <> 0 Then Exit For
    processSeen = True
    If Not IsNull(process.ExecutablePath) And Not IsNull(process.CommandLine) Then
      If StrComp(CStr(process.ExecutablePath), expectedNodePath, vbTextCompare) = 0 Then
        processCommandLine = CStr(process.CommandLine)
        If InStr(1, processCommandLine, expectedServerPath, vbTextCompare) > 0 Then found = True
      End If
    End If
  Next
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
  ElseIf Not processSeen Then
    CheckPackagedServerProcess = -1
  ElseIf Not found Then
    CheckPackagedServerProcess = 0
  Else
    CheckPackagedServerProcess = 1
  End If
End Function

Sub ShowLaunchFailure(message)
  MsgBox message & vbCrLf & vbCrLf & "Review these logs for the startup error:" & vbCrLf & launcherLogPath & vbCrLf & serverLogPath, vbExclamation, "The Timeless Sovereign Story Studio"
End Sub
VBS

cat > "$payload/Stop-Story-Studio.vbs" <<'VBS'
Option Explicit
Dim files, shell, serverPath, appRoot, expectedNodePath, candidatePort, serverState
On Error Resume Next
serverPath = ""
If WScript.Arguments.Count > 0 Then serverPath = WScript.Arguments(0)
If serverPath = "" Then WScript.Quit 0
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
If Err.Number <> 0 Then
  MsgBox "Story Studio could not check for a running installed server. Close it before installing the update.", vbExclamation, "Story Studio could not close"
  WScript.Quit 1
End If
appRoot = files.GetParentFolderName(files.GetParentFolderName(serverPath))
expectedNodePath = appRoot & "\runtime\node.exe"

' 4317 is checked only for an exact match to the old packaged installation.
For Each candidatePort In Array(4318, 4317)
  serverState = CheckPackagedServerProcess(candidatePort, expectedNodePath, serverPath)
  If serverState = 1 Then WScript.Quit StopPackagedServer(candidatePort)
  If candidatePort = 4318 And serverState < 0 Then
    If IsStoryStudioResponding(candidatePort) Then
      MsgBox "Story Studio is responding on port 4318, but Windows could not verify that it belongs to this installation. Close that app before installing the update.", vbExclamation, "Story Studio could not close"
      WScript.Quit 1
    End If
  End If
Next
WScript.Quit 0

Function CheckPackagedServerProcess(port, expectedNodePath, expectedServerPath)
  On Error Resume Next
  Dim netstat, outputLine, expression, matches, ownerPid
  Dim service, processes, process, processCommandLine, processSeen, found
  Err.Clear
  Set netstat = shell.Exec("cmd.exe /d /c netstat -ano -p tcp")
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  Set expression = New RegExp
  expression.IgnoreCase = True
  expression.Pattern = "^\s*TCP\s+\S+:" & CStr(port) & "\s+\S+\s+LISTENING\s+([0-9]+)"
  ownerPid = ""
  Do Until netstat.StdOut.AtEndOfStream
    outputLine = netstat.StdOut.ReadLine
    Set matches = expression.Execute(Trim(outputLine))
    If matches.Count > 0 Then
      ownerPid = matches(0).SubMatches(0)
      Exit Do
    End If
  Loop
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  If ownerPid = "" Then
    CheckPackagedServerProcess = 0
    Exit Function
  End If
  Set service = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  Set processes = service.ExecQuery("SELECT ExecutablePath, CommandLine FROM Win32_Process WHERE ProcessId=" & ownerPid)
  If Err.Number <> 0 Then
    CheckPackagedServerProcess = -1
    Err.Clear
    Exit Function
  End If
  processSeen = False
  found = False
  For Each process In processes
    processSeen = True
    If Not IsNull(process.ExecutablePath) And Not IsNull(process.CommandLine) Then
      If StrComp(CStr(process.ExecutablePath), expectedNodePath, vbTextCompare) = 0 Then
        processCommandLine = CStr(process.CommandLine)
        If InStr(1, processCommandLine, expectedServerPath, vbTextCompare) > 0 Then found = True
      End If
    End If
  Next
  If Err.Number <> 0 Or Not processSeen Then
    CheckPackagedServerProcess = -1
    Err.Clear
  ElseIf found Then
    CheckPackagedServerProcess = 1
  Else
    CheckPackagedServerProcess = 0
  End If
End Function

Function IsStoryStudioResponding(port)
  On Error Resume Next
  Dim request
  Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then
    IsStoryStudioResponding = False
    Err.Clear
    Exit Function
  End If
  request.SetTimeouts 500, 500, 500, 500
  request.Open "GET", "http://127.0.0.1:" & CStr(port) & "/api/bootstrap", False
  request.Send
  IsStoryStudioResponding = False
  If Err.Number = 0 And request.Status = 200 Then
    IsStoryStudioResponding = InStr(1, request.ResponseText, """csrfToken""", vbTextCompare) > 0 And InStr(1, request.ResponseText, """appVersion""", vbTextCompare) > 0
  End If
  Err.Clear
End Function

Function StopPackagedServer(port)
  On Error Resume Next
  Dim request, expression, matches, attempt, address
  address = "http://127.0.0.1:" & CStr(port)
  Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then
    StopPackagedServer = ShowStopFailure("Story Studio could not verify its local server. Close it before installing the update.")
    Exit Function
  End If
  request.SetTimeouts 500, 500, 500, 500
  request.Open "GET", address & "/api/bootstrap", False
  request.Send
  If Err.Number <> 0 Or request.Status <> 200 Then
    StopPackagedServer = ShowStopFailure("The installed Story Studio server is not responding. Close it before installing the update.")
    Exit Function
  End If
  Set expression = New RegExp
  expression.Pattern = """csrfToken""\s*:\s*""([^""]+)"""
  Set matches = expression.Execute(request.ResponseText)
  If matches.Count = 0 Then
    StopPackagedServer = ShowStopFailure("Story Studio could not verify its local server. Close it before installing the update.")
    Exit Function
  End If
  request.Open "POST", address & "/api/app/shutdown", False
  request.SetRequestHeader "Origin", address
  request.SetRequestHeader "X-CSRF-Token", matches(0).SubMatches(0)
  request.SetRequestHeader "Content-Type", "application/json"
  request.Send "{}"
  If Err.Number <> 0 Then
    StopPackagedServer = ShowStopFailure("Story Studio could not be stopped safely. Close it before installing the update.")
    Exit Function
  End If
  If request.Status = 409 Then
    MsgBox "A story response is still running. Wait for it to finish, then run the installer again.", vbInformation, "Story Studio is busy"
    StopPackagedServer = 1
    Exit Function
  End If
  If request.Status <> 200 Then
    StopPackagedServer = ShowStopFailure("Story Studio could not be stopped safely. Close it before installing the update.")
    Exit Function
  End If
  For attempt = 1 To 120
    WScript.Sleep 250
    Err.Clear
    Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
    request.SetTimeouts 500, 500, 500, 500
    request.Open "GET", address & "/api/bootstrap", False
    request.Send
    If Err.Number <> 0 Then
      StopPackagedServer = 0
      Exit Function
    End If
    If request.Status <> 200 And request.Status <> 503 Then
      StopPackagedServer = ShowStopFailure("Story Studio stopped responding unexpectedly. Close it and try again.")
      Exit Function
    End If
  Next
  StopPackagedServer = ShowStopFailure("Story Studio did not close in time. Close it and try again.")
End Function

Function ShowStopFailure(message)
  MsgBox message, vbExclamation, "Story Studio could not close"
  ShowStopFailure = 1
End Function
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
