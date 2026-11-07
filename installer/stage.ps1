# Assembles the folder every Windows package is made from, build/stage-<arch>/:
#
#   Threadbear.exe             the desktop shell (desktop/src-tauri), unsigned here
#   node/node.exe              the pinned Node (installer/node.json), so nothing
#                              has to be on the PATH
#   runner/                    the runner's source and its production packages
#   desktop/bridge, dist, ...  the bridge the shell starts, and the built UI
#   docs/                      the guide and protocol every thread's agent is
#                              pointed at, and what they point to
#   LICENSE, README.md, INSTALL.md, README-WINDOWS.txt
#   THIRD-PARTY-NOTICES.txt    the licence of every package and crate that ships
#
# The same layout the repo has, so the shell finds the bridge and the runner
# finds its guide without being told. Run once per architecture, after the
# shell and the UI are built (build-installers.ps1 does all of it).
#
# The tree is relocatable: nothing in it names this machine's folders, so it can
# be copied to another machine and packaged there (build-installers.ps1
# -FromStage). Signing is not done here; the packaging step signs Threadbear.exe.
#
#   pwsh installer/stage.ps1 -Arch x64 -ShellExe desktop/src-tauri/target/release/threadbear-desktop.exe

param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64",
    [Parameter(Mandatory)]
    [string]$ShellExe,
    [string]$Version = "",   # the version being packaged; defaults to desktop/package.json
    [string]$StageDir = ""   # defaults to build/stage-<arch>
)

$ErrorActionPreference = "Stop"
$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $installerDir
. (Join-Path $installerDir "common.ps1")
if (-not $StageDir) { $StageDir = Join-Path $repo "build\stage-$Arch" }
$stage = [System.IO.Path]::GetFullPath($StageDir)

function Invoke-Native([string]$What, [scriptblock]$Block) {
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

# --- The shell: right architecture and right version, before anything else ---
if (-not (Test-Path $ShellExe)) { throw "The shell was not found at $ShellExe. Build it first (npx tauri build --no-bundle in desktop/)" }
if (-not $Version) {
    $Version = (& node (Join-Path $repo "desktop\scripts\version.mjs") --print).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read the version from desktop/package.json" }
}
Assert-PeMachine $ShellExe $Arch
Assert-ShellVersion $ShellExe $Version

# The folder is emptied first, so refuse one that looks like it is not a stage
if (Test-Path $stage) {
    $existing = @(Get-ChildItem $stage -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0 -and -not (Test-Path (Join-Path $stage "Threadbear.exe"))) {
        throw "$stage is not empty and does not look like an earlier stage (no Threadbear.exe in it). Pick an empty folder."
    }
    Remove-Item $stage -Recurse -Force
}
New-Item -ItemType Directory -Force $stage | Out-Null

# --- Shell (unsigned: the packaging step signs it before it goes into a package) ---
Copy-Item $ShellExe (Join-Path $stage "Threadbear.exe") -Force

# --- Node ---
& (Join-Path $installerDir "fetch-node.ps1") -Arch $Arch
$nodeDir = Join-Path $stage "node"
New-Item -ItemType Directory -Force $nodeDir | Out-Null
Copy-Item (Join-Path $repo "build\node-$Arch\*") $nodeDir -Force
Assert-PeMachine (Join-Path $nodeDir "node.exe") $Arch

# --- Runner: source plus production packages only ---
$run = Join-Path $stage "runner"
New-Item -ItemType Directory -Force (Join-Path $run "scripts") | Out-Null
Copy-Item (Join-Path $repo "runner\src") (Join-Path $run "src") -Recurse
Copy-Item (Join-Path $repo "runner\bin") (Join-Path $run "bin") -Recurse
foreach ($f in "windows-run.mjs", "install-windows.mjs", "agent-sdk.mjs", "agent-sdk-preload.mjs") {
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
$nodeModules = Join-Path $run "node_modules"

# The Agent SDK is not shipped. It is Anthropic's, all rights reserved and
# subject to their terms, so a package made here does not redistribute it. A
# Mac install gets it from `npm ci` on the person's own machine; this one gets
# it on its first start the same way, from the registry, checked against the
# hash in the package-lock.json that is copied above (scripts/agent-sdk.mjs).
# That also drops the platform packages with their own copy of Claude Code (283
# MB), which the runner never runs: it always passes the path of the person's
# own claude (pathToClaudeCodeExecutable, adapters/claude/adapter.ts).
$anthropic = Join-Path $nodeModules "@anthropic-ai"
if (Test-Path $anthropic) {
    Get-ChildItem $anthropic -Directory -Filter "claude-agent-sdk*" |
        ForEach-Object { Write-Host "Leaving out $($_.Name) ($([math]::Round((Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)) MB): fetched from npm on the first start"; Remove-Item $_.FullName -Recurse -Force }
    if (-not (Get-ChildItem $anthropic -Force)) { Remove-Item $anthropic -Force }
}
if (Test-Path (Join-Path $nodeModules "@anthropic-ai\claude-agent-sdk")) { throw "The Agent SDK is still in the staged runner. It must not ship." }
# Node reads the lock: PowerShell's ConvertFrom-Json refuses its "" package key.
$sdkLock = (node -e "const p = require(process.argv[1]).packages['node_modules/@anthropic-ai/claude-agent-sdk'] || {}; console.log(JSON.stringify(p))" (Join-Path $run "package-lock.json")) | ConvertFrom-Json
if (-not ($sdkLock.version -and $sdkLock.resolved -and $sdkLock.integrity)) { throw "package-lock.json has no version, address and hash for the Agent SDK, so the first start could not fetch it." }
Write-Host "The Agent SDK $($sdkLock.version) is fetched on the first start from $($sdkLock.resolved)"

# The `sentry` package is Sentry's command line tool (15 MB, under the FSL
# licence), pulled in by @sentry/bundler-plugins, which only the build-plugin
# entries of @sentry/node load (@sentry/node/esbuild, /rollup, /vite, /webpack).
# The runner imports @sentry/node itself, and only in a release build of the
# author's own repository (src/sentry.ts), never on a Windows install. Left in
# if anything else asks for it by name.
$sentryCli = Join-Path $nodeModules "sentry"
if ((Test-Path (Join-Path $sentryCli "package.json")) -and ((Get-Content (Join-Path $sentryCli "package.json") -Raw | ConvertFrom-Json).name -eq "sentry")) {
    $users = Get-ChildItem $nodeModules -Recurse -File -Include *.js, *.cjs, *.mjs -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notlike "$sentryCli\*" -and $_.FullName -notlike "*\@sentry\bundler-plugins\*" } |
        Select-String -Pattern "require\(['""]sentry['""]\)|from ['""]sentry['""]|import\(['""]sentry['""]\)" -List
    if ($users) {
        Write-Host "Keeping the sentry command line tool: $(@($users)[0].Path) asks for it"
    } else {
        Write-Host "Leaving out sentry, Sentry's command line tool ($([math]::Round((Get-ChildItem $sentryCli -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) MB)"
        Remove-Item $sentryCli -Recurse -Force
    }
}
# esbuild and prettier are left in: the runner runs the Convex command line
# tool from its own packages (src/convex-keys.ts), which bundles with esbuild
# and formats with prettier, and nothing here proves a given command never does.

# Files nothing reads at run time: type declarations, source maps, markdown.
# Thousands of them, and each one is a file to unpack, scan and (for the MSI)
# keep in a component. Licence files are never pruned, whatever their extension
# (LICENSE.md, license.markdown, NOTICE.md): the licences ask for the notice to
# travel with copies.
$keep = '^(licen[sc]e|copying|notice|patents|copyright|unlicen[sc]e)([-_. ].*)?$'
$pruned = Get-ChildItem $nodeModules -Recurse -File -Include *.d.ts, *.d.mts, *.d.cts, *.map, *.md, *.markdown -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch $keep }
Write-Host "Pruning $(($pruned | Measure-Object).Count) declaration, map and markdown files from the runner's packages (licence files stay)"
$pruned | Remove-Item -Force

# --- Desktop: the bridge, the built UI, and the one package the bridge needs ---
$desk = Join-Path $stage "desktop"
$bridgeSrc = Join-Path $repo "desktop\bridge"
$bridgeDst = Join-Path $desk "bridge"
New-Item -ItemType Directory -Force $bridgeDst | Out-Null
# bridge.ts and the files next to it that it imports (never the tests)
$queue = [System.Collections.Generic.Queue[string]]::new()
$queue.Enqueue("bridge.ts")
$copied = @{}
while ($queue.Count -gt 0) {
    $name = $queue.Dequeue()
    if ($copied.ContainsKey($name)) { continue }
    $copied[$name] = $true
    Copy-Item (Join-Path $bridgeSrc $name) (Join-Path $bridgeDst $name)
    foreach ($m in [regex]::Matches((Get-Content (Join-Path $bridgeSrc $name) -Raw), "(?m)^\s*(?:import|export)\b[^;]*?from\s+['""]\./([\w.-]+\.ts)['""]")) {
        $queue.Enqueue($m.Groups[1].Value)
    }
}
Copy-Item (Join-Path $repo "desktop\package.json") (Join-Path $desk "package.json")
$dist = Join-Path $repo "desktop\dist"
if (-not (Test-Path (Join-Path $dist "index.html"))) { throw "desktop/dist is not built. Run npm run build in desktop/" }
Copy-Item $dist (Join-Path $desk "dist") -Recurse
$ws = Join-Path $repo "desktop\node_modules\ws"
if (-not (Test-Path $ws)) { throw "desktop/node_modules/ws is missing. Run npm ci in desktop/" }
New-Item -ItemType Directory -Force (Join-Path $desk "node_modules") | Out-Null
Copy-Item $ws (Join-Path $desk "node_modules\ws") -Recurse

# --- The docs the runner points agents at, licence, readmes ---
# guideLine() and patchesLine() (runner/src/threadbear-mcp.ts) look for
# <root>/docs/guide.md and <root>/docs/protocol.md, and tell the agent the rest
# of the docs are in <root>. patchesLine() adds the "make a patch" instruction
# only when protocol.md is there. guide.md points at INSTALL.md, protocol.md and
# on-your-mac.md; the other docs the protocol mentions are Mac-side detail and
# are left out.
New-Item -ItemType Directory -Force (Join-Path $stage "docs") | Out-Null
foreach ($f in "guide.md", "protocol.md", "on-your-mac.md") {
    Copy-Item (Join-Path $repo "docs\$f") (Join-Path $stage "docs\$f")
}
foreach ($f in "LICENSE", "README.md", "INSTALL.md") {
    Copy-Item (Join-Path $repo $f) (Join-Path $stage $f)
}
Copy-Item (Join-Path $installerDir "readme-windows.txt") (Join-Path $stage "README-WINDOWS.txt")

# --- Third-party notices: the licence of everything that ships ---
$cargoExe = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $cargoExe) { throw "cargo is not on the PATH. The notices list the Rust crates the shell is built from, so Rust has to be installed (the shell was built with it)." }
$triple = if ($Arch -eq "arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
$nodeVersion = (Get-Content (Join-Path $installerDir "node.json") -Raw | ConvertFrom-Json).version
Invoke-Native "make-notices.mjs" {
    node (Join-Path $installerDir "make-notices.mjs") --stage $stage --desktop (Join-Path $repo "desktop") `
        --cargo-manifest (Join-Path $repo "desktop\src-tauri\Cargo.toml") --triple $triple `
        --node-version $nodeVersion --out (Join-Path $stage "THIRD-PARTY-NOTICES.txt")
}

# --- Relocatable: nothing may name a folder of this machine ---
$here = @($repo, ($repo -replace '\\', '/'))
$named = Get-ChildItem $stage -Recurse -File -Force |
    Where-Object { -not $_.FullName.StartsWith($nodeModules + "\") -or $_.Name -eq ".package-lock.json" -or $_.DirectoryName.EndsWith("\.bin") } |
    Where-Object { $_.Extension -in ".json", ".js", ".mjs", ".cjs", ".ts", ".cmd", ".ps1", ".txt", ".md", ".html", ".css" -or $_.Name -eq "tb" } |
    Select-String -SimpleMatch -Pattern $here -List
if ($named) { throw "Staged files name this machine's folders ($repo), so the stage could not be moved: $(@($named)[0].Path)" }

$count = (Get-ChildItem $stage -Recurse -File | Measure-Object).Count
$mb = [math]::Round((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Staged $count files ($mb MB) in $stage"
