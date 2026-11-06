# Builds the Threadbear Windows packages for one architecture into dist/:
#   threadbear-v<version>-setup-win-<arch>.exe     (Inno Setup, interactive)
#   threadbear-v<version>-msi-win-<arch>.msi       (WiX, silent-install oriented)
#   threadbear-v<version>-portable-win-<arch>.zip  (the same files, unpacked anywhere)
# plus a .sha256 for each. <arch> is x64 (default) or arm64 (-Arch arm64); run
# it once per architecture.
#
# Requirements (Windows): Inno Setup 6 (ISCC.exe), WiX (dotnet tool: wix), Node
# and npm, Rust (the notices list the shell's crates), and a built shell for that
# architecture: the shell is desktop/src-tauri/target/release/threadbear-desktop.exe
# for x64, and desktop/src-tauri/target/aarch64-pc-windows-msvc/release/ for arm64
# (build with `npx tauri build --no-bundle [--target aarch64-pc-windows-msvc]` in
# desktop/), or pass -ShellExe. The UI must be built (desktop/dist). Both
# installers build on an x64 machine.
#
# Three ways to run it:
#
#   build-installers.ps1 -Arch x64
#       Stages the unsigned tree (build/stage-<arch>), then packages it. Signs
#       when -SignCmd is given.
#
#   build-installers.ps1 -Arch x64 -StageOnly [-StageDir <dir>]
#       Only stages the unsigned tree, shell included, and compiles nothing.
#       This is the step that runs npm, cargo and the other installs.
#
#   build-installers.ps1 -Arch x64 -FromStage <dir> -Version <v> -Publisher <name> [-SignCmd <script>]
#       Packages an existing staged tree. It runs no npm, no cargo and no
#       installs, so a job that holds a signing identity never runs a package's
#       install script. It signs Threadbear.exe inside the staged tree in place,
#       then builds the three packages from it.
#
# Code signing is optional and external: pass -SignCmd with a script (.ps1) or an
# executable that signs the single file given as its first argument (CI
# generates one that wraps signtool with Azure Artifact Signing). When set,
# Threadbear.exe is signed BEFORE packaging so the binary inside every package
# carries the signature, Inno signs its uninstaller and setup exe through the
# same command, and the MSI is signed last. Checksums are computed after all of
# that, since signing changes the bytes.

param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64",
    [string]$ShellExe = "",    # defaults to the release build for $Arch
    [string]$Version = "",     # override; defaults to desktop/package.json (required with -FromStage)
    [string]$SignCmd = "",     # a "sign one file" script or executable; empty = unsigned
    [string]$Publisher = "",   # defaults to $env:THREADBEAR_PUBLISHER, else Platima
    [switch]$StageOnly,        # stage the unsigned tree and stop
    [string]$FromStage = "",   # package this staged tree instead of staging one
    [string]$StageDir = "",    # where staging goes; defaults to build/stage-<arch>
    [string]$OutDir = ""       # where the packages go; defaults to dist/
)

$ErrorActionPreference = "Stop"
$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $installerDir
. (Join-Path $installerDir "common.ps1")

if ($StageOnly -and $FromStage) { throw "-StageOnly and -FromStage cannot be used together: one stages, the other packages a stage" }
if ($FromStage -and $ShellExe) { throw "-ShellExe does not apply with -FromStage: the shell is already in the staged tree" }
if ($FromStage -and $StageDir) { throw "-StageDir does not apply with -FromStage: the stage is the folder given" }

$dist = if ($OutDir) { [System.IO.Path]::GetFullPath($OutDir) } else { Join-Path $repo "dist" }

# --- Version: one number in desktop/package.json, checked against the rest ---
if ($FromStage) {
    # Nothing is run from the repo here (no node needed): the staging job has
    # already checked the numbers agree, and the version is given.
    if (-not $Version) { throw "-Version is required with -FromStage (the staged tree does not say which release it is for)" }
} else {
    & node (Join-Path $repo "desktop\scripts\version.mjs") --check
    if ($LASTEXITCODE -ne 0) { throw "The version numbers disagree: see above" }
    if (-not $Version) { $Version = (& node (Join-Path $repo "desktop\scripts\version.mjs") --print).Trim() }
}
if (-not ($Version -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')) { throw "'$Version' is not a semantic version" }
# Windows Installer wants numbers only: 1.2.3-rc1 becomes 1.2.3 for the MSI
# (the file names still carry the full version).
$msiVersion = ($Version -replace '-.*$', '')
if (-not $Publisher) { $Publisher = if ($env:THREADBEAR_PUBLISHER) { $env:THREADBEAR_PUBLISHER } else { "Platima" } }

# --- The signing command: an existing .ps1 or executable, as a full path ---
if ($SignCmd) {
    $found = if (Test-Path $SignCmd) { (Resolve-Path $SignCmd).Path } else { (Get-Command $SignCmd -ErrorAction SilentlyContinue)?.Source }
    if (-not $found) { throw "-SignCmd '$SignCmd' is not a file or a command on the PATH" }
    $SignCmd = $found
}

function Invoke-Signing([string]$Path) {
    if (-not $SignCmd) { return }
    Write-Host "Signing $(Split-Path -Leaf $Path)..."
    & $SignCmd $Path
    if ($LASTEXITCODE -ne 0) { throw "Signing failed for $Path (exit code $LASTEXITCODE)" }
}

# --- Shell (only needed to stage) ---
function Get-ShellExe {
    if ($ShellExe) { return $ShellExe }
    $rel = if ($Arch -eq "arm64") { "desktop\src-tauri\target\aarch64-pc-windows-msvc\release" } else { "desktop\src-tauri\target\release" }
    Join-Path $repo "$rel\threadbear-desktop.exe"
}

# --- Stage only: the unsigned tree, then stop ---
if ($StageOnly) {
    if ($SignCmd) { Write-Host "-SignCmd is not used with -StageOnly: Threadbear.exe is signed when the stage is packaged (-FromStage)." }
    Write-Host "Staging $Arch for Threadbear $Version (unsigned)"
    $stageArgs = @{ Arch = $Arch; ShellExe = (Get-ShellExe); Version = $Version }
    if ($StageDir) { $stageArgs.StageDir = $StageDir }
    & (Join-Path $installerDir "stage.ps1") @stageArgs
    return
}

Write-Host "Building $Arch packages for Threadbear $Version$(if ($SignCmd) { ' (signed)' } else { ' (unsigned)' })"

# --- Tools ---
$iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { $iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue)?.Source }
if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) not found. Install it with: winget install JRSoftware.InnoSetup" }
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    throw "WiX not found. Install it with: dotnet tool install --global wix"
}

# --- Stage (unless one was given): shell, Node, runner, bridge, UI ---
if ($FromStage) {
    $stage = [System.IO.Path]::GetFullPath($FromStage)
    if (-not (Test-Path $stage)) { throw "-FromStage folder not found: $stage" }
    Write-Host "Packaging the staged tree in $stage"
} else {
    $stageArgs = @{ Arch = $Arch; ShellExe = (Get-ShellExe); Version = $Version }
    if ($StageDir) { $stageArgs.StageDir = $StageDir }
    & (Join-Path $installerDir "stage.ps1") @stageArgs
    $stage = if ($StageDir) { [System.IO.Path]::GetFullPath($StageDir) } else { Join-Path $repo "build\stage-$Arch" }
}

# --- Check the tree is what the packages expect, whoever staged it ---
foreach ($f in "Threadbear.exe", "node\node.exe", "node\LICENSE", "runner\package.json", "runner\scripts\install-windows.mjs",
               "desktop\bridge\bridge.ts", "desktop\dist\index.html", "docs\guide.md", "docs\protocol.md", "LICENSE", "THIRD-PARTY-NOTICES.txt") {
    if (-not (Test-Path (Join-Path $stage $f))) { throw "The staged tree is missing $f ($stage)" }
}
Assert-PeMachine (Join-Path $stage "Threadbear.exe") $Arch
Assert-PeMachine (Join-Path $stage "node\node.exe") $Arch
Assert-ShellVersion (Join-Path $stage "Threadbear.exe") $Version
# Inno Setup cannot open a file whose full path is over 259 characters, and says
# only "The system cannot find the path specified". The deepest files are in
# node_modules (about 150 characters below the stage), so a stage in a deep
# folder fails; say so here.
$deepest = Get-ChildItem $stage -Recurse -File -Force | Sort-Object { $_.FullName.Length } -Descending | Select-Object -First 1
if ($deepest.FullName.Length -gt 259) {
    throw "The staged tree is too deep for Inno Setup ($($deepest.FullName.Length) characters at $($deepest.FullName)). Stage into a shorter folder (-StageDir) or build from a shorter path."
}

New-Item -ItemType Directory -Force $dist | Out-Null

# --- Sign the shell first, so the binary inside every package carries it ---
Invoke-Signing (Join-Path $stage "Threadbear.exe")

# --- Inno Setup ---
Write-Host "Compiling Inno Setup installer..."
$isccArgs = @("/Q", "/O$dist", "/DAppVersion=$Version", "/DArch=$Arch", "/DStage=$stage", "/DPublisher=$Publisher")
if ($SignCmd) {
    # threadbear.iss enables SignTool=threadbearsign and SignedUninstaller=yes
    # under #ifdef Sign; the tool itself is defined here on the command line
    # so the script carries no machine-specific path. $f is Inno's file
    # placeholder. A .ps1 is run through pwsh rather than cmd.exe /c, because
    # Inno substitutes $f as a QUOTED path and cmd's quote-stripping rule then
    # breaks a command with four quotes in it; an executable is run directly.
    # pwsh rather than powershell.exe: launched from a pwsh parent, Windows
    # PowerShell 5.1 inherits a PSModulePath it cannot load modules from.
    # $q is Inno's escape for a quote.
    $isccArgs += "/DSign=1"
    if ($SignCmd -match '\.ps1$') {
        $isccArgs += "/Sthreadbearsign=pwsh.exe -NoProfile -File `$q$SignCmd`$q `$f"
    } else {
        $isccArgs += "/Sthreadbearsign=`$q$SignCmd`$q `$f"
    }
}
& $iscc @isccArgs (Join-Path $installerDir "threadbear.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
$setupExe = Join-Path $dist "threadbear-v$Version-setup-win-$Arch.exe"
if (-not (Test-Path $setupExe)) { throw "Expected output missing: $setupExe" }
# Not signed here: with SignTool set, Inno signs the finished setup exe itself
# (as well as the uninstaller). A second pass would just spend a signing call.

# --- MSI ---
Write-Host "Building MSI..."
$msi = Join-Path $dist "threadbear-v$Version-msi-win-$Arch.msi"
# wix resolves the .wxs's relative Source paths against the current directory.
# -pdbtype none: the .wixpdb is not a deliverable and would sit in dist/.
Push-Location $installerDir
try {
    wix build threadbear.wxs -arch $Arch -pdbtype none -d "Version=$msiVersion" -d "StageDir=$stage" -d "Publisher=$Publisher" -o $msi
    if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
Invoke-Signing $msi

# --- Portable: the very same files, in a folder inside a zip ---
$portable = Join-Path $dist "threadbear-v$Version-portable-win-$Arch.zip"
if (Test-Path $portable) { Remove-Item $portable -Force }
$wrap = Join-Path (Split-Path -Parent $stage) "portable-$Arch"
if (Test-Path $wrap) { Remove-Item $wrap -Recurse -Force }
New-Item -ItemType Directory -Force $wrap | Out-Null
Copy-Item $stage (Join-Path $wrap "Threadbear") -Recurse
Compress-Archive -Path (Join-Path $wrap "Threadbear") -DestinationPath $portable -CompressionLevel Optimal
Remove-Item $wrap -Recurse -Force

# --- Checksums (after signing: the signature is part of the bytes) ---
foreach ($f in @($setupExe, $msi, $portable)) {
    $hash = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
    # Trailing newline matters: these get concatenated into CHECKSUMS.txt
    "$hash  $(Split-Path -Leaf $f)`n" | Set-Content -NoNewline "$f.sha256"
    Write-Host ("{0}  {1}  ({2:N0} bytes)" -f $hash, (Split-Path -Leaf $f), (Get-Item $f).Length)
}
Write-Host "Packages ready in $dist"
