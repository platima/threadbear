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
;
; An upgrade over a copy that is still running first asks the app to quit and
; ends the runner's task, then waits (up to 20 seconds) until node\node.exe and
; Threadbear.exe can be written to. If something still holds them, the setup log
; says what, the person is asked whether to end it (a silent install says yes),
; and if anything still holds them after that, Setup stops in PrepareToInstall,
; before [InstallDelete] has removed a file: exit code 7 when silent, the old
; install untouched. release-folder.ps1 does the looking and the ending (see
; PrepareToInstall below). With no PowerShell it carries on as it always did.

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
; Setup's helper for freeing the install folder: carried inside the setup, used
; from PrepareToInstall, never installed.
#define HelperName "release-folder.ps1"
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
; First, because Setup unpacks every file ahead of one it extracts with
; ExtractTemporaryFile (solid compression). Not installed: dontcopy.
Source: "{#HelperName}"; Flags: dontcopy noencryption
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
//
// Asking is not stopping. An upgrade has failed on a node.exe that was still
// running afterwards, with nothing in the log to say which, so an install then
// waits for the files to be free, says what holds them if they are not, and
// stops before anything is deleted (FreeTheFolder).
const
  InnoUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#AppGuid}_is1';
  AppPathsKey = 'Software\Microsoft\Windows\CurrentVersion\App Paths\Threadbear.exe';
  // How long to wait for the files to be let go of once the app and the runner
  // have been asked to stop, and how long again after ending what was left.
  WaitSeconds = 20;
  AfterEndSeconds = 10;

var
  HelperExtracted: Boolean;

// Dir, when it holds Threadbear.exe, without a trailing backslash; else ''.
function FolderWithApp(const Dir: String): String;
begin
  Result := '';
  if Dir = '' then Exit;
  if FileExists(RemoveBackslash(Dir) + '\{#AppExe}') then
    Result := RemoveBackslash(Dir);
end;

// The folder of a copy that is already installed, from what Windows has on
// record: the App Paths entry of this install mode first (all this ever looked
// at), then the same entry in each place a per-user or a system-wide install
// writes it, in either registry view, then the folder in this setup's own
// uninstall entry. So a copy installed the other way round is found as well.
// Not found: the zip, which records nothing (the folder being installed to,
// {app}, covers it when that is the one chosen), and the MSI, which records
// neither and which this setup will not install over.
function PreviousInstall(): String;
var
  Value: String;
begin
  Result := '';
  Value := '';
  if RegQueryStringValue(HKA, AppPathsKey, '', Value) then
    Result := FolderWithApp(ExtractFileDir(Value));
  if Result <> '' then Exit;
  if RegQueryStringValue(HKCU, AppPathsKey, '', Value) then
    Result := FolderWithApp(ExtractFileDir(Value));
  if Result <> '' then Exit;
  if RegQueryStringValue(HKLM64, AppPathsKey, '', Value) then
    Result := FolderWithApp(ExtractFileDir(Value));
  if Result <> '' then Exit;
  if RegQueryStringValue(HKLM32, AppPathsKey, '', Value) then
    Result := FolderWithApp(ExtractFileDir(Value));
  if Result <> '' then Exit;
  if RegQueryStringValue(HKCU, InnoUninstallKey, 'Inno Setup: App Path', Value) then
    Result := FolderWithApp(Value);
  if Result <> '' then Exit;
  if RegQueryStringValue(HKLM64, InnoUninstallKey, 'Inno Setup: App Path', Value) then
    Result := FolderWithApp(Value);
  if Result <> '' then Exit;
  if RegQueryStringValue(HKLM32, InnoUninstallKey, 'Inno Setup: App Path', Value) then
    Result := FolderWithApp(Value);
end;

// Runs a program and says in the log how it ended. What it was asked to do is
// not checked here (neither of these says anything of use); the folder is.
procedure RunAndLog(const Exe, Params, WorkDir: String);
var
  Code: Integer;
begin
  if Exec(Exe, Params, WorkDir, SW_HIDE, ewWaitUntilTerminated, Code) then
    Log(Exe + ' ' + Params + ' ended with exit code ' + IntToStr(Code))
  else
    Log(Exe + ' ' + Params + ' could not be run: ' + SysErrorMessage(Code) + ' (' + IntToStr(Code) + ')');
end;

// Asks the copy in Dir to quit and its runner to stop. With Settle, gives both a
// moment to let go of their files (the uninstaller, which has no helper, does
// that; an install waits on the files themselves instead). Does nothing when
// there is no copy to ask.
procedure StopCopyIn(const Dir: String; const Settle: Boolean);
var
  Exe: String;
begin
  if Dir = '' then Exit;
  Exe := Dir + '\{#AppExe}';
  if not FileExists(Exe) then Exit;
  RunAndLog(Exe, '--quit', Dir);
  RunAndLog(Exe, '--runner --stop', Dir);
  if Settle then Sleep(1500);
end;

// ------------------------------------------------------------------ the helper
// release-folder.ps1 finds out whether the files are free, lists what is running
// from the folder, and ends what is left (it explains its own checks). It speaks
// in a report file of lines whose fields are split by bars.

// Windows PowerShell 5.1, which every Windows 10 and 11 has, or '' if it is not
// where it should be.
function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(Result) then Result := '';
end;

// Runs the helper with a verb (Wait, End) for Dir and loads its report. False
// when it could not be run or left no report: PowerShell missing or stopped by
// policy or AppLocker, the script not unpacked, anything at all. Setup carries
// on without the helper then; it never fails an install.
function RunHelper(const Verb, Dir, Extra: String; var Report: TArrayOfString): Boolean;
var
  PowerShell, Script, ReportFile: String;
  Code: Integer;
begin
  Result := False;
  SetArrayLength(Report, 0);
  PowerShell := PowerShellExe();
  if PowerShell = '' then
  begin
    Log('release-folder: Windows PowerShell was not found');
    Exit;
  end;
  try
    if not HelperExtracted then
    begin
      ExtractTemporaryFile('{#HelperName}');
      HelperExtracted := True;
    end;
  except
    Log('release-folder: the helper could not be unpacked: ' + GetExceptionMessage);
    Exit;
  end;
  Script := ExpandConstant('{tmp}\{#HelperName}');
  ReportFile := ExpandConstant('{tmp}\release-folder-report.txt');
  DeleteFile(ReportFile);
  if not Exec(PowerShell,
       '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -Action ' + Verb +
       ' -Folder "' + RemoveBackslashUnlessRoot(Dir) + '" -OutFile "' + ReportFile + '"' + Extra,
       ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Log('release-folder: PowerShell could not be run: ' + SysErrorMessage(Code) + ' (' + IntToStr(Code) + ')');
    Exit;
  end;
  Log('release-folder: ' + Verb + ' ended with exit code ' + IntToStr(Code));
  if not LoadStringsFromFile(ReportFile, Report) then
  begin
    Log('release-folder: it left no report (the script may have been blocked)');
    Exit;
  end;
  Result := GetArrayLength(Report) > 0;
end;

// The first field of Line, which is cut off it along with the bar after it.
function TakeField(var Line: String): String;
var
  P: Integer;
begin
  P := Pos('|', Line);
  if P = 0 then
  begin
    Result := Line;
    Line := '';
  end
  else
  begin
    Result := Copy(Line, 1, P - 1);
    Line := Copy(Line, P + 1, Length(Line) - P);
  end;
end;

// What follows Tag and a bar on the first line of the report that starts so.
function ReportValue(var Report: TArrayOfString; const Tag: String): String;
var
  I: Integer;
  Line: String;
begin
  Result := '';
  for I := 0 to GetArrayLength(Report) - 1 do
  begin
    Line := Report[I];
    if TakeField(Line) = Tag then
    begin
      Result := TakeField(Line);
      Exit;
    end;
  end;
end;

// The report in the setup log (/LOG), which is where the command lines of what
// holds the folder stay: nothing here is sent anywhere.
procedure LogReport(var Report: TArrayOfString);
var
  I: Integer;
begin
  for I := 0 to GetArrayLength(Report) - 1 do
    Log('release-folder: ' + Report[I]);
end;

function WhyNot(const Verdict: String): String;
begin
  if Verdict = 'keep:other-owner' then
    Result := 'it is not running as you'
  else if Verdict = 'keep:setup-itself' then
    Result := 'it is what Setup was started from'
  else if Verdict = 'keep:start-time-unreadable' then
    Result := 'Windows would not say when it started'
  else
    Result := 'it is not clearly part of {#AppName}';
end;

// Reads the programs the report lists. Endable gets a line for each that Setup
// may end and Other one for each that it may not (and why). Pairs is the
// "number:start" of the first kind, as the helper wants them back.
procedure DescribeHolders(var Report: TArrayOfString; var Endable, Other, Pairs: String);
var
  I: Integer;
  Line, ProcId, ProcStart, ProcName, Verdict, ProcFile, Command, Shown: String;
begin
  Endable := '';
  Other := '';
  Pairs := '';
  for I := 0 to GetArrayLength(Report) - 1 do
  begin
    Line := Report[I];
    if TakeField(Line) = 'PROC' then
    begin
      ProcId := TakeField(Line);
      TakeField(Line);
      ProcStart := TakeField(Line);
      ProcName := TakeField(Line);
      Verdict := TakeField(Line);
      ProcFile := TakeField(Line);
      Command := Line;
      if Command = '' then Command := ProcFile;
      Shown := '  ' + ProcName + ' (process ' + ProcId + '): ' + Copy(Command, 1, 200) + #13#10;
      if Verdict = 'end' then
      begin
        Endable := Endable + Shown;
        if Pairs <> '' then Pairs := Pairs + ',';
        Pairs := Pairs + ProcId + ':' + ProcStart;
      end
      else
        Other := Other + Shown + '    Setup will not end this one: ' + WhyNot(Verdict) + '.' + #13#10;
    end;
  end;
end;

// What PrepareToInstall says when the files are still held: which, by what, and
// that nothing has been changed (it is said before [InstallDelete] runs).
function StuckMessage(const Dir: String; var Report: TArrayOfString): String;
var
  I: Integer;
  Line, Held, Endable, Other, Pairs: String;
begin
  Held := '';
  for I := 0 to GetArrayLength(Report) - 1 do
  begin
    Line := Report[I];
    if TakeField(Line) = 'FILE' then
      if TakeField(Line) = 'held' then
        Held := Held + '  ' + Line + #13#10;
  end;
  DescribeHolders(Report, Endable, Other, Pairs);
  Result := '{#AppName} is still running, so Setup cannot replace its files in ' + Dir + '.' + #13#10#13#10 +
    'Windows says these are open:' + #13#10 + Held;
  if (Endable <> '') or (Other <> '') then
    Result := Result + #13#10 + 'Running from that folder:' + #13#10 + Endable + Other
  else
    Result := Result + #13#10 + 'Setup could not tell which program has them open.' + #13#10;
  Result := Result + #13#10 + 'Close it, or end it in Task Manager, then run Setup again. Nothing in the folder has been changed.';
end;

// Whether Setup may end the programs listed. A silent install cannot be asked,
// and says yes: the old copy is being replaced, and ending the runner's task
// already ends it hard. /SUPPRESSMSGBOXES gives the same yes to a visible one.
function AskToEnd(const Dir, Endable: String): Boolean;
begin
  if WizardSilent then
  begin
    Result := True;
    Exit;
  end;
  Result := SuppressibleMsgBox(
    '{#AppName} is still running from ' + Dir + ', and Setup cannot replace its files while it is.' + #13#10#13#10 +
    Endable + #13#10 +
    'Setup can end these for you. Anything they are doing stops straight away.' + #13#10#13#10 +
    'End them and carry on?',
    mbConfirmation, MB_YESNO, IDYES) = IDYES;
end;

// Waits for the files this setup replaces to be free. Returns '' when they are
// (or when that could not be found out: Setup then does what it always did,
// which is to give the app a moment and go on). Returns a message when they are
// still held after the wait and after ending what the helper may end, and
// PrepareToInstall passes it on, so Setup stops before [InstallDelete] has
// removed anything and the old install is left as it was.
function FreeTheFolder(const Dir: String): String;
var
  Report, Ended, After: TArrayOfString;
  Condition, Endable, Other, Pairs: String;
begin
  Result := '';

  // A fresh install has nothing to hold. A drive root is left to Setup: the
  // helper will not work on one, as every program on the drive is inside it.
  if not (FileExists(Dir + '\node\node.exe') or FileExists(Dir + '\{#AppExe}')) then Exit;
  if Length(Dir) <= 3 then
  begin
    Log('release-folder: ' + Dir + ' is a drive root, so Setup carries on without the helper');
    Sleep(1500);
    Exit;
  end;

  Condition := '';
  if RunHelper('Wait', Dir, ' -Seconds ' + IntToStr(WaitSeconds), Report) then
  begin
    LogReport(Report);
    Condition := ReportValue(Report, 'STATE');
  end;
  if Condition = 'free' then Exit;
  if Condition <> 'held' then
  begin
    Log('release-folder: no answer, so Setup carries on without the helper');
    Sleep(1500);
    Exit;
  end;

  // Still held after the wait.
  DescribeHolders(Report, Endable, Other, Pairs);
  if Pairs <> '' then
  begin
    if AskToEnd(Dir, Endable) then
    begin
      Log('release-folder: ending ' + Pairs);
      if RunHelper('End', Dir, ' -Expect "' + Pairs + '"', Ended) then LogReport(Ended);
      if RunHelper('Wait', Dir, ' -Seconds ' + IntToStr(AfterEndSeconds), After) then
      begin
        LogReport(After);
        Condition := ReportValue(After, 'STATE');
        if Condition = 'free' then Exit;
        if Condition = 'held' then
        begin
          Result := StuckMessage(Dir, After);
          Log('Setup stopped before changing anything: ' + Result);
          Exit;
        end;
        Log('release-folder: no answer, so Setup carries on without the helper');
        Sleep(1500);
        Exit;
      end;
    end
    else
      Log('release-folder: the person chose not to end them');
  end;

  Result := StuckMessage(Dir, Report);
  Log('Setup stopped before changing anything: ' + Result);
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

// Before [InstallDelete] and the copy, so a message from here leaves the old
// install exactly as it was. The copy that is on record is asked to quit and its
// runner to stop, and so is whatever is in the folder being installed to (it may
// not be on record: a zip, or the other registry hive), then the files that
// copy would replace are waited for (FreeTheFolder).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dir, Previous: String;
begin
  Dir := ExpandConstant('{app}');
  Previous := PreviousInstall();
  Log('Installing to ' + Dir + '; an earlier copy is on record at "' + Previous + '"');
  StopCopyIn(Previous, False);
  if not SameText(Previous, Dir) then
    StopCopyIn(Dir, False);
  Result := FreeTheFolder(Dir);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // Before any file is removed. The [UninstallRun] entry ends the task and
  // removes `tb` whichever of the two comes first. The uninstaller cannot
  // unpack the helper, so it only gives the files a moment.
  if CurUninstallStep = usUninstall then
    StopCopyIn(ExpandConstant('{app}'), True);
end;
