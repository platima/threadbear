# Assembles the folder every Windows package is made from, build/stage-<arch>/:
#
#   Threadbear.exe             the desktop shell (desktop/src-tauri)
#   node/node.exe              the pinned Node (installer/node.json), so nothing
#                              has to be on the PATH
#   runner/                    the runner's source and its production packages
#   desktop/bridge, dist, ...  the bridge the shell starts, and the built UI
#   docs/guide.md              the user guide every thread's agent is pointed at
#   LICENSE, README.md
#
# The same layout the repo has, so the shell finds the bridge and the runner
# finds its guide without being told. Run once per architecture, after the
# shell is built (build-installers.ps1 does all of it).
#
#   pwsh installer/stage.ps1 -Arch x64 -ShellExe desktop/src-tauri/target/release/threadbear-desktop.exe

param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64",
    [Parameter(Mandatory)]
    [string]$ShellExe,
    [string]$SignCmd = ""    # signs one file; empty = unsigned
)

$ErrorActionPreference = "Stop"
$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $installerDir
$stage = Join-Path $repo "build\stage-$Arch"

function Invoke-Native([string]$What, [scriptblock]$Block) {
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

# --- The shell: check it is the right architecture before anything else ---
if (-not (Test-Path $ShellExe)) { throw "The shell was not found at $ShellExe - build it first (npx tauri build --no-bundle in desktop/)" }
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $ShellExe).Path)
$machine = [BitConverter]::ToUInt16($bytes, [BitConverter]::ToInt32($bytes, 0x3C) + 4)
$wantMachine = if ($Arch -eq "arm64") { 0xAA64 } else { 0x8664 }
if ($machine -ne $wantMachine) {
    throw ("{0} is not an {1} executable (PE machine 0x{2:X4})" -f $ShellExe, $Arch, $machine)
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

# --- Shell, signed before it goes into any package ---
$stagedShell = Join-Path $stage "Threadbear.exe"
Copy-Item $ShellExe $stagedShell -Force
if ($SignCmd) {
    Write-Host "Signing Threadbear.exe..."
    & $SignCmd $stagedShell
    if ($LASTEXITCODE -ne 0) { throw "Signing failed for Threadbear.exe (exit code $LASTEXITCODE)" }
}

# --- Node ---
& (Join-Path $installerDir "fetch-node.ps1") -Arch $Arch
$nodeDir = Join-Path $stage "node"
New-Item -ItemType Directory -Force $nodeDir | Out-Null
Copy-Item (Join-Path $repo "build\node-$Arch\*") $nodeDir -Force

# --- Runner: source plus production packages only ---
$run = Join-Path $stage "runner"
New-Item -ItemType Directory -Force (Join-Path $run "scripts") | Out-Null
Copy-Item (Join-Path $repo "runner\src") (Join-Path $run "src") -Recurse
Copy-Item (Join-Path $repo "runner\bin") (Join-Path $run "bin") -Recurse
foreach ($f in "windows-run.mjs", "install-windows.mjs") {
    Copy-Item (Join-Path $repo "runner\scripts\$f") (Join-Path $run "scripts\$f")
}
foreach ($f in "package.json", "package-lock.json") {
    Copy-Item (Join-Path $repo "runner\$f") (Join-Path $run $f)
}
# --os/--cpu so a build on x64 gets arm64's native packages (oxc-parser and
# the Agent SDK ship one per platform). --ignore-scripts: nothing here needs
# an install script, and none should run on a build machine.
$npmCpu = $Arch
Push-Location $run
try {
    Invoke-Native "npm ci (runner)" { npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=win32 --cpu=$npmCpu }
} finally { Pop-Location }

# The Agent SDK carries its own copy of Claude Code (283 MB) in a platform
# package. The runner always passes the path of the person's own claude
# (pathToClaudeCodeExecutable, adapters/claude/adapter.ts), so the copy is
# never run, and Threadbear only ever spawns the official CLI under the
# person's own login. Take it out.
Get-ChildItem (Join-Path $run "node_modules\@anthropic-ai") -Directory -Filter "claude-agent-sdk-*" |
    Where-Object { $_.Name -ne "claude-agent-sdk" } |
    ForEach-Object { Write-Host "Leaving out $($_.Name) ($([math]::Round((Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) MB)"; Remove-Item $_.FullName -Recurse -Force }

# Files nothing reads at run time: type declarations, source maps, markdown.
# Thousands of them, and each one is a file to unpack, scan and (for the MSI)
# keep in a component.
$pruned = Get-ChildItem (Join-Path $run "node_modules") -Recurse -File -Include *.d.ts, *.d.mts, *.d.cts, *.map, *.md, *.markdown -ErrorAction SilentlyContinue
Write-Host "Pruning $(($pruned | Measure-Object).Count) declaration, map and markdown files from the runner's packages"
$pruned | Remove-Item -Force

# --- Desktop: the bridge, the built UI, and the one package the bridge needs ---
$desk = Join-Path $stage "desktop"
New-Item -ItemType Directory -Force (Join-Path $desk "bridge") | Out-Null
Copy-Item (Join-Path $repo "desktop\bridge\bridge.ts") (Join-Path $desk "bridge\bridge.ts")
Copy-Item (Join-Path $repo "desktop\package.json") (Join-Path $desk "package.json")
$dist = Join-Path $repo "desktop\dist"
if (-not (Test-Path (Join-Path $dist "index.html"))) { throw "desktop/dist is not built - run npm run build in desktop/" }
Copy-Item $dist (Join-Path $desk "dist") -Recurse
$ws = Join-Path $repo "desktop\node_modules\ws"
if (-not (Test-Path $ws)) { throw "desktop/node_modules/ws is missing - run npm ci in desktop/" }
New-Item -ItemType Directory -Force (Join-Path $desk "node_modules") | Out-Null
Copy-Item $ws (Join-Path $desk "node_modules\ws") -Recurse

# --- The guide, licence, readme ---
New-Item -ItemType Directory -Force (Join-Path $stage "docs") | Out-Null
Copy-Item (Join-Path $repo "docs\guide.md") (Join-Path $stage "docs\guide.md")
Copy-Item (Join-Path $repo "LICENSE") (Join-Path $stage "LICENSE")
Copy-Item (Join-Path $repo "README.md") (Join-Path $stage "README.md")

$count = (Get-ChildItem $stage -Recurse -File | Measure-Object).Count
$mb = [math]::Round((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Staged $count files ($mb MB) in $stage"
