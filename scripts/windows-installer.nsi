Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetOverwrite on

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "1.3.0"
!endif

Name "The Timeless Sovereign Story Studio"
OutFile "../dist/windows/The-Timeless-Sovereign-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\The Timeless Sovereign Story Studio"
InstallDirRegKey HKCU "Software\TheTimelessSovereign\StoryStudio" "InstallDir"
ShowInstDetails show
ShowUninstDetails show

!define APP_KEY "Software\TheTimelessSovereign\StoryStudio"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TheTimelessSovereignStoryStudio"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  IfFileExists "$INSTDIR\app\src\server.mjs" 0 fresh_install
  InitPluginsDir
  File /oname=$PLUGINSDIR\Stop-Story-Studio.vbs "../dist/windows/payload/Stop-Story-Studio.vbs"
  ExecWait '"$SYSDIR\wscript.exe" "$PLUGINSDIR\Stop-Story-Studio.vbs" "$INSTDIR\app\src\server.mjs"' $0
  ${If} $0 != 0
    Abort
  ${EndIf}
fresh_install:
FunctionEnd

Section "Story Studio" MainSection
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "../dist/windows/payload/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "The Timeless Sovereign Story Studio"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\The Timeless Sovereign Story Studio"
  CreateShortCut "$SMPROGRAMS\The Timeless Sovereign Story Studio\Story Studio.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\Launch-Story-Studio.vbs"' "$INSTDIR\app\runtime\node.exe"
  CreateShortCut "$SMPROGRAMS\The Timeless Sovereign Story Studio\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\The Timeless Sovereign Story Studio\Story Studio.lnk"
  Delete "$SMPROGRAMS\The Timeless Sovereign Story Studio\Uninstall.lnk"
  RMDir "$SMPROGRAMS\The Timeless Sovereign Story Studio"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
