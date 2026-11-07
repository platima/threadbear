; Threadbear interactive installer (Inno Setup 6)
; Build: ISCC /DAppVersion=x.y.z /DStage=<build\stage-x64> threadbear.iss
; (see build-installers.ps1, which stages the files first)
;
; Defaults to a per-user install; the dialog (or /ALLUSERS, or launching
; elevated) switches to a system-wide install. The runner's logon task is not
; created here: the app offers it the first time it opens (docs/windows-port-plan.md),
; so the setup exe, the MSI and the portable zip all behave the same, and it is
; per user whichever way the app was installed. Upgrading ends the task so its
; files can be replaced and starts it again once they are in place (a [Run]
; entry, which does nothing when no task is registered). Uninstalling removes
; the task.
;
; This setup and the MSI install to the same default folder under different
; identities, so each refuses to install while the other's copy is there
; (see InitializeSetup). Setup also refuses to go back to an older version,
; as the MSI does.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
; The numbers of the version, for the file version resource (1.2.3-rc1 gives 1.2.3)
#define DashAt Pos("-", AppVersion)
#if DashAt > 0
  #define NumericVersion Copy(AppVersion, 1, DashAt - 1)
#else
  #define NumericVersion AppVersion
#endif
; Target architecture, x64 or arm64 (ISCC /DArch=arm64), and the staged folder
; for it (/DStage=<path>). One AppId for both: installing the other
; architecture's setup over an install replaces it in place.
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef Stage
  #define Stage "..\build\stage-x64"
#endif
#if Arch != "x64" && Arch != "arm64"
  #error Arch must be x64 or arm64
#endif
; Whose name is on the installer and in Add/Remove Programs. Override with
; /DPublisher="..." (build-installers.ps1 -Publisher, or THREADBEAR_PUBLISHER).
#ifndef Publisher
  #define Publisher "Platima"
#endif
; The line in the setup exe's file properties; the same as the LICENSE's.
#ifndef Copyright
  #define Copyright "Copyright (c) 2026 Mike Cann"
#endif
#define AppName "Threadbear"
#define AppURL "https://github.com/platima/threadbear"
#define AppExe "Threadbear.exe"
; AppId below is this GUID. The MSI checks for this setup's uninstall entry by it
; (InnoUninstallKey in threadbear.wxs), and this setup looks for the MSI by its
; UpgradeCode (MsiUpgradeCode here, UpgradeCode in the .wxs): keep each pair in
; step with the other file.
#define AppGuid "{3F6A9D52-8B1E-4C47-A5D0-72E9C41B6F38}"
#define MsiUpgradeCode "{B04D7E19-5C28-4A63-9F81-2D6E3A7C5B40}"

[Setup]
; The brace is doubled because { starts a constant; the rest is AppGuid
AppId={{#AppGuid}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
; Add/Remove Programs shows just "Threadbear": the version has its own column
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=..\dist
OutputBaseFilename=threadbear-v{#AppVersion}-setup-win-{#Arch}
; The setup exe's own file properties (Explorer, SmartScreen, the signature dialog)
VersionInfoVersion={#NumericVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoCompany={#Publisher}
VersionInfoDescription={#AppName} setup
VersionInfoCopyright={#Copyright}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
#if Arch == "arm64"
; Windows on Arm only: an arm64 build cannot run anywhere else
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
; x64compatible includes Windows on Arm, which runs x64 code under emulation
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
; Nothing here edits the environment: the runner's own script puts `tb` on the
; user's PATH, from the app's first run.
; The app and the runner are asked to stop in PrepareToInstall, through their
; own routes (they have no window the Restart Manager could close), so it is
; not asked to do it.
CloseApplications=no
RestartApplications=no
MinVersion=10.0.17763
LicenseFile={#Stage}\LICENSE
#ifdef Sign
; Only when the build passes /DSign=1 and defines the tool with
; /Sthreadbearsign="<sign one file>" $f (build-installers.ps1 -SignCmd). The
; uninstaller is a separate binary and needs its own signature, or Windows
; shows an unknown-publisher prompt on uninstall alone.
SignTool=threadbearsign
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
; What the setup does not install, said on the last page and never blocking.
FinishedLabel=Setup has finished installing [name] on your computer. The application may be launched by selecting the installed shortcuts.%n%n[name] also needs two things it does not install: Git for Windows (git-scm.com), whose bash runs patch actions, project checks and "tb land", and Claude Code, signed in by running "claude auth login" in a terminal. Install them if they are not already there.
FinishedLabelNoIcons=Setup has finished installing [name] on your computer.%n%n[name] also needs two things it does not install: Git for Windows (git-scm.com), whose bash runs patch actions, project checks and "tb land", and Claude Code, signed in by running "claude auth login" in a terminal. Install them if they are not already there.

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[InstallDelete]
; Files that an older release had and this one does not, so an upgrade leaves
; what a fresh install would (the MSI's major upgrade removes the old product
; first). These folders hold only what this setup put there: the data is in
; %APPDATA%\Threadbear, the logs in %LOCALAPPDATA%\Threadbear, and nothing
; writes into the install folder, so the folder itself is left alone.
Type: filesandordirs; Name: "{app}\runner"
Type: filesandordirs; Name: "{app}\desktop"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\docs"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\Third-party notices"; Filename: "{app}\THIRD-PARTY-NOTICES.txt"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Win+R "threadbear"
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\Threadbear.exe"; ValueType: string; ValueData: "{app}\{#AppExe}"; Flags: uninsdeletekey

[Run]
; PrepareToInstall ended the runner's task for the upgrade; this starts it again
; once the new files are in. It does nothing when no task is registered (a first
; install, or someone who said no), prints a line and exits 0. As the user who
; started setup, because the task belongs to that user and setup may be
; elevated. Not waited for, and not skipped when silent: a scripted upgrade
; should leave the runner going too.
Filename: "{app}\{#AppExe}"; Parameters: "--runner --start"; WorkingDir: "{app}"; StatusMsg: "Starting the runner..."; Flags: runhidden nowait runasoriginaluser
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The Claude Agent SDK the runner fetched from npm on its first start
; (runner\scripts\agent-sdk.mjs), in the folder of the person removing this.
Type: filesandordirs; Name: "{localappdata}\Threadbear\sdk"

[UninstallRun]
; Removes the logon task and the `tb` command. The data folder is left alone.
; The app and the runner are asked to stop before this, in CurUninstallStepChanged.
Filename: "{app}\{#AppExe}"; Parameters: "--runner --uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "RemoveRunnerTask"

[Code]
// The app has no window the installer could close and the runner's files stay
// open while it runs, so both are asked to stop through their own routes
// before files are replaced or removed: the app by a second launch with --quit
// (it listens for that), the runner by ending its logon task (the task stays
// registered; the [Run] entry above starts it again after an upgrade).
const
  InnoUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#AppGuid}_is1';

var
  Previous: String;

function PreviousInstall(): String;
var
  Dir: String;
begin
  Result := '';
  if RegQueryStringValue(HKA, 'Software\Microsoft\Windows\CurrentVersion\App Paths\Threadbear.exe', '', Dir) then
    if FileExists(Dir) then
      Result := ExtractFileDir(Dir);
end;

// Asks the copy in Dir to quit and its runner to stop, then gives both a moment
// to let go of their files. Does nothing when there is no copy to ask.
procedure StopCopyIn(const Dir: String);
var
  Code: Integer;
  Exe: String;
begin
  if Dir = '' then Exit;
  Exe := Dir + '\{#AppExe}';
  if not FileExists(Exe) then Exit;
  Exec(Exe, '--quit', Dir, SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(Exe, '--runner --stop', Dir, SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(1500);
end;

// Microsoft Edge WebView2 is what the window is drawn with. Windows 11 and an
// updated Windows 10 have it; it is recorded in the machine's or the user's
// registry, under either view.
function WebView2Present(): Boolean;
var
  Version: String;
begin
  Version := '';
  Result :=
    RegQueryStringValue(HKLM64, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;

// True when the MSI package's product is installed for this user or the machine
// (found by its UpgradeCode, so it works for either scope and any version).
function MsiCopyInstalled(): Boolean;
begin
  Result := False;
  try
    Result := IsMsiProductInstalled('{#MsiUpgradeCode}', 0);
  except
    Log('Could not ask Windows Installer about an MSI copy: ' + GetExceptionMessage);
  end;
end;

// The version of this setup's own earlier install (HKCU for a per-user one, HKLM
// for a system-wide one), or '' when there is none.
function InstalledSetupVersion(): String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, InnoUninstallKey, 'DisplayVersion', Result) then Exit;
  if RegQueryStringValue(HKLM64, InnoUninstallKey, 'DisplayVersion', Result) then Exit;
  if RegQueryStringValue(HKLM32, InnoUninstallKey, 'DisplayVersion', Result) then Exit;
  Result := '';
end;

// "1.2.3" or "1.2.3-rc1" as a packed version. A pre-release suffix is dropped,
// the way the MSI drops it, so the two compare alike.
function PackedCore(const S: String; var Value: Int64): Boolean;
var
  Core: String;
  I, Dots: Integer;
begin
  Core := S;
  I := Pos('-', Core);
  if I > 0 then Core := Copy(Core, 1, I - 1);
  Dots := 0;
  for I := 1 to Length(Core) do
    if Core[I] = '.' then Dots := Dots + 1;
  while Dots < 3 do
  begin
    Core := Core + '.0';
    Dots := Dots + 1;
  end;
  Result := StrToVersion(Core, Value);
end;

function IsDowngrade(): Boolean;
var
  Installed: String;
  Have, Mine: Int64;
begin
  Result := False;
  Installed := InstalledSetupVersion();
  if Installed = '' then Exit;
  if PackedCore(Installed, Have) and PackedCore('{#AppVersion}', Mine) then
    Result := ComparePackedVersion(Have, Mine) > 0;
end;

// Stops setup with a plain message. A silent install shows nothing (a message
// box would wait for a click that never comes, since only /SUPPRESSMSGBOXES
// silences them) and ends with exit code 1, "failed to initialize"; the reason
// is in the log when /LOG is given.
function Refuse(const Reason: String): Boolean;
begin
  Log('Setup stopped: ' + Reason);
  if not WizardSilent then
    SuppressibleMsgBox(Reason, mbError, MB_OK, IDOK);
  Result := False;
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
begin
  Result := True;

  if MsiCopyInstalled() then
  begin
    Result := Refuse('{#AppName} is already installed from the MSI package. Remove that copy first (Settings, Apps, Installed apps), then run this setup again.');
    Exit;
  end;

  if IsDowngrade() then
  begin
    Result := Refuse('A newer version of {#AppName} (' + InstalledSetupVersion() + ') is already installed, and this setup is for ' + '{#AppVersion}' + '. To go back to the older version, remove the newer one first (Settings, Apps, Installed apps).');
    Exit;
  end;

  if not WebView2Present() then
  begin
    // Windows 11 and an updated Windows 10 have it. Say so rather than
    // install something we cannot pin.
    Log('Setup stopped: Microsoft Edge WebView2 is not installed');
    if not WizardSilent then
      if SuppressibleMsgBox('{#AppName} needs Microsoft Edge WebView2, which this PC does not seem to have.' + #13#10#13#10 +
                            'Open the download page now? Install it, then run this setup again.',
                            mbConfirmation, MB_YESNO, IDNO) = IDYES then
        ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, Code);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Previous := PreviousInstall();
  StopCopyIn(Previous);
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // Before any file is removed. The [UninstallRun] entry ends the task and
  // removes `tb` whichever of the two comes first.
  if CurUninstallStep = usUninstall then
    StopCopyIn(ExpandConstant('{app}'));
end;
