# Fetches the pinned Node (installer/node.json) for one architecture and leaves
# node.exe and its LICENSE in build/node-<arch>/. The zip is checked against the
# SHA-256 in node.json, so a changed or corrupt download stops the build.
# Idempotent: a zip already in build/downloads that passes the check is reused.
#
#   pwsh installer/fetch-node.ps1 -Arch x64
#   pwsh installer/fetch-node.ps1 -Arch arm64

param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"
$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $installerDir
$pin = Get-Content (Join-Path $installerDir "node.json") -Raw | ConvertFrom-Json
$version = $pin.version
$want = $pin.sha256.$Arch
if (-not $want) { throw "node.json has no sha256 for $Arch" }

$downloads = Join-Path $repo "build\downloads"
$out = Join-Path $repo "build\node-$Arch"
New-Item -ItemType Directory -Force $downloads | Out-Null

$name = "node-v$version-win-$Arch.zip"
$zip = Join-Path $downloads $name

function Test-Zip {
    (Test-Path $zip) -and ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -eq $want.ToLower())
}

if (-not (Test-Zip)) {
    $url = "https://nodejs.org/dist/v$version/$name"
    Write-Host "Downloading $url"
    Invoke-WebRequest $url -OutFile $zip
    if (-not (Test-Zip)) {
        $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
        Remove-Item $zip -Force
        throw "$name does not match the pinned SHA-256 (wanted $want, got $got)"
    }
}
Write-Host "$name matches its pinned SHA-256"

# Only node.exe and the licence: the runner does not need npm, and leaving it
# out saves about 10 MB.
$extract = Join-Path $downloads "extract-$Arch"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive $zip $extract -Force
$inner = Join-Path $extract "node-v$version-win-$Arch"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $inner "node.exe") (Join-Path $out "node.exe") -Force
Copy-Item (Join-Path $inner "LICENSE") (Join-Path $out "LICENSE") -Force
Remove-Item $extract -Recurse -Force

# The PE machine field, so an x64 node can never be packaged as arm64.
$bytes = [System.IO.File]::ReadAllBytes((Join-Path $out "node.exe"))
$machine = [BitConverter]::ToUInt16($bytes, [BitConverter]::ToInt32($bytes, 0x3C) + 4)
$wantMachine = if ($Arch -eq "arm64") { 0xAA64 } else { 0x8664 }
if ($machine -ne $wantMachine) { throw ("node.exe is not an {0} executable (PE machine 0x{1:X4})" -f $Arch, $machine) }
Write-Host "Node v$version ($Arch) ready in $out"
