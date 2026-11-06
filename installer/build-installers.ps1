# Builds the Threadbear Windows packages for one architecture into dist/:
#   threadbear-v<version>-setup-win-<arch>.exe     (Inno Setup, interactive)
#   threadbear-v<version>-msi-win-<arch>.msi       (WiX, silent-install oriented)
#   threadbear-v<version>-portable-win-<arch>.zip  (the same files, unpacked anywhere)
# plus a .sha256 for each. <arch> is x64 (default) or arm64 (-Arch arm64); run
# it once per architecture.
#
# Requirements (Windows): Inno Setup 6 (ISCC.exe), WiX (dotnet tool: wix), Node
# and npm, and a built shell for that architecture: the shell is
# desktop/src-tauri/target/release/threadbear-desktop.exe for x64, and
# desktop/src-tauri/target/aarch64-pc-windows-msvc/release/ for arm64 (build
# with `npx tauri build --no-bundle [--target aarch64-pc-windows-msvc]` in
# desktop/), or pass -ShellExe. The UI must be built (desktop/dist). Both
# installers build on an x64 machine.
#
# Code signing is optional and external: pass -SignCmd with a script or
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
    [string]$Version = "",     # override; defaults to desktop/package.json
    [string]$SignCmd = "",     # a "sign one file" command; empty = unsigned
    [string]$Publisher = ""    # defaults to $env:THREADBEAR_PUBLISHER, else Platima
)

$ErrorActionPreference = "Stop"
$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $installerDir
$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Force $dist | Out-Null

function Invoke-Signing([string]$Path) {
    if (-not $SignCmd) { return }
    Write-Host "Signing $(Split-Path -Leaf $Path)..."
    & $SignCmd $Path
    if ($LASTEXITCODE -ne 0) { throw "Signing failed for $Path (exit code $LASTEXITCODE)" }
}

# --- Version: one number in desktop/package.json, checked against the rest ---
& node (Join-Path $repo "desktop\scripts\version.mjs") --check
if ($LASTEXITCODE -ne 0) { throw "The version numbers disagree - see above" }
if (-not $Version) { $Version = (& node (Join-Path $repo "desktop\scripts\version.mjs") --print).Trim() }
if (-not ($Version -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')) { throw "'$Version' is not a semantic version" }
# Windows Installer wants numbers only: 1.2.3-rc1 becomes 1.2.3 for the MSI
# (the file names still carry the full version).
$msiVersion = ($Version -replace '-.*$', '')
if (-not $Publisher) { $Publisher = if ($env:THREADBEAR_PUBLISHER) { $env:THREADBEAR_PUBLISHER } else { "Platima" } }
Write-Host "Building $Arch packages for Threadbear $Version$(if ($SignCmd) { ' (signed)' } else { ' (unsigned)' })"

# --- Shell ---
if (-not $ShellExe) {
    $rel = if ($Arch -eq "arm64") { "desktop\src-tauri\target\aarch64-pc-windows-msvc\release" } else { "desktop\src-tauri\target\release" }
    $ShellExe = Join-Path $repo "$rel\threadbear-desktop.exe"
}

# --- Tools ---
$iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { $iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue)?.Source }
if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) not found - winget install JRSoftware.InnoSetup" }
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    throw "WiX not found - dotnet tool install --global wix"
}

# --- Stage: shell, Node, runner, bridge, UI ---
& (Join-Path $installerDir "stage.ps1") -Arch $Arch -ShellExe $ShellExe -SignCmd $SignCmd
$stage = Join-Path $repo "build\stage-$Arch"

# --- Inno Setup ---
Write-Host "Compiling Inno Setup installer..."
$isccArgs = @("/Q", "/DAppVersion=$Version", "/DArch=$Arch", "/DStage=$stage", "/DPublisher=$Publisher")
if ($SignCmd) {
    # threadbear.iss enables SignTool=threadbearsign and SignedUninstaller=yes
    # under #ifdef Sign; the tool itself is defined here on the command line
    # so the script carries no machine-specific path. $f is Inno's file
    # placeholder. SignCmd is a .ps1 (CI writes one); Inno runs it through pwsh
    # rather than cmd.exe /c, because Inno substitutes $f as a QUOTED path and
    # cmd's quote-stripping rule then breaks a command with four quotes in it.
    # pwsh rather than powershell.exe: launched from a pwsh parent, Windows
    # PowerShell 5.1 inherits a PSModulePath it cannot load modules from.
    # $q is Inno's escape for a quote.
    $isccArgs += "/DSign=1"
    $isccArgs += "/Sthreadbearsign=pwsh.exe -NoProfile -File `$q$SignCmd`$q `$f"
}
& $iscc @isccArgs (Join-Path $installerDir "threadbear.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
$setupExe = Join-Path $dist "threadbear-v$Version-setup-win-$Arch.exe"
if (-not (Test-Path $setupExe)) { throw "Expected output missing: $setupExe" }
# Not signed here: with SignTool set, Inno signs the finished setup exe itself
# (as well as the uninstaller) - a second pass would just spend a signing call.

# --- MSI ---
Write-Host "Building MSI..."
$msi = Join-Path $dist "threadbear-v$Version-msi-win-$Arch.msi"
# wix resolves the .wxs's relative Source paths against the current directory
Push-Location $installerDir
try {
    wix build threadbear.wxs -arch $Arch -d "Version=$msiVersion" -d "StageDir=$stage" -d "Publisher=$Publisher" -o $msi
    if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
Invoke-Signing $msi

# --- Portable: the very same files, in a folder inside a zip ---
$portable = Join-Path $dist "threadbear-v$Version-portable-win-$Arch.zip"
if (Test-Path $portable) { Remove-Item $portable -Force }
$wrap = Join-Path $repo "build\portable-$Arch"
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
