; Threadbear interactive installer (Inno Setup 6)
; Build: ISCC /DAppVersion=x.y.z /DStage=<build\stage-x64> threadbear.iss
; (see build-installers.ps1, which stages the files first)
;
; Defaults to a per-user install; the dialog (or /ALLUSERS, or launching
; elevated) switches to a system-wide install. The runner's logon task is not
; set up here: the app offers it the first time it opens (docs/windows-port-plan.md),
; so the setup exe, the MSI and the portable zip all behave the same, and it is
; per user whichever way the app was installed. Uninstalling removes the task.

#ifndef AppVersion
  #define AppVersion "0.0.0"
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
#define AppName "Threadbear"
#define AppURL "https://github.com/platima/threadbear"
#define AppExe "Threadbear.exe"

[Setup]
AppId={{3F6A9D52-8B1E-4C47-A5D0-72E9C41B6F38}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
; Add/Remove Programs shows just "Threadbear" - the version has its own column
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=..\dist
OutputBaseFilename=threadbear-v{#AppVersion}-setup-win-{#Arch}
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

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Win+R "threadbear"
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\Threadbear.exe"; ValueType: string; ValueData: "{app}\{#AppExe}"; Flags: uninsdeletekey

[Run]
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Removes the logon task and the `tb` command. The data folder is left alone.
Filename: "{app}\{#AppExe}"; Parameters: "--runner --uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveRunnerTask"

[Code]
// The app has no window the installer could close and the runner's files stay
// open while it runs, so both are asked to stop through their own routes
// before files are replaced: the app by a second launch with --quit (it
// listens for that), the runner by ending its logon task (the task stays
// registered, and the app offers to start it again when it next opens).
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

procedure StopRunningCopy();
var
  Code: Integer;
begin
  if Previous = '' then Exit;
  Exec(Previous + '\{#AppExe}', '--quit', Previous, SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(Previous + '\{#AppExe}', '--runner --stop', Previous, SW_HIDE, ewWaitUntilTerminated, Code);
  // Give both a moment to let go of their files.
  Sleep(1500);
end;

function WebView2Present(): Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if not WebView2Present() then
  begin
    // Windows 11 and an updated Windows 10 have it. Say so rather than
    // install something we cannot pin.
    if MsgBox('Threadbear needs Microsoft Edge WebView2, which this PC does not seem to have.' + #13#10#13#10 +
              'Open the download page now? Install it, then run this setup again.',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, Code);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Previous := PreviousInstall();
  StopRunningCopy();
  Result := '';
end;
