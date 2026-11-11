# Runs the built setup exe over a copy of itself while programs hold the install
# folder, and checks what it does (release-folder.ps1, threadbear.iss
# PrepareToInstall). The "upgrade over a running copy" job in
# .github/workflows/installers.yml runs it:
#
#   pwsh -NoProfile -File installer/test-upgrade-over-running.ps1 -Setup <setup exe> -WorkDir <empty folder>
#
# THROWAWAY MACHINES ONLY. The real setup shares its AppId, its App Paths and
# uninstall registry keys, its Start Menu entry and the user's Task Scheduler
# task with a real install, so this installs it, upgrades it and uninstalls it
# again as if it were that one. It refuses to run unless it is on a GitHub-hosted
# runner, or -ThrowawayMachine says the machine can be spoilt.
#
# What it checks, all with a setup run silently (/VERYSILENT /SUPPRESSMSGBOXES):
#   1. A fresh install into <WorkDir>\Threadbear works.
#   2. With a program running from <install>\node\node.exe (so the file cannot be
#      replaced), a second run of the setup ends that program, and only that one,
#      and completes the upgrade: the runner folder is rebuilt, which a marker
#      file placed in it proves, and the setup log says what it ended.
#      Controls that must survive: a copy of node.exe in another folder, and one
#      in a sibling folder whose name starts the same (Threadbear2).
#   3. With node.exe held by something that is not a program running from the
#      folder (a handle this script keeps open), a third run waits, then stops
#      with exit code 7 before [InstallDelete] has touched anything: the marker is
#      still there. Releasing the handle, a fourth run completes.
# Then it uninstalls. Everything it starts is ended through the handle it kept.

param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [switch]$ThrowawayMachine
)

$ErrorActionPreference = 'Stop'

if (-not $ThrowawayMachine -and $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This installs, upgrades and removes the real Threadbear setup, so it only runs on a GitHub-hosted runner. On another machine that can be spoilt, pass -ThrowawayMachine.'
}
if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "The setup exe is not there: $Setup" }

$Setup = (Resolve-Path -LiteralPath $Setup).Path
New-Item -ItemType Directory -Force $WorkDir | Out-Null
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
if ($WorkDir -match '\s') { throw "Use a work folder with no spaces in its path (setup's /DIR and /LOG are passed unquoted): $WorkDir" }

$install = Join-Path $WorkDir 'Threadbear'
$otherDir = Join-Path $WorkDir 'Other'
$lookalikeDir = Join-Path $WorkDir 'Threadbear2'
$nodeExe = Join-Path $install 'node\node.exe'
$marker = Join-Path $install 'runner\stale-marker.txt'

function Assert-That {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAILED: $Message" }
    Write-Host "ok: $Message"
}

# Runs the setup silently into $install and gives its exit code, how long it took
# and its log. Waits for the setup process itself, not for anything it started.
function Invoke-Setup {
    param([string]$Label)
    $log = Join-Path $WorkDir "$Label.log"
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Setup
    $info.Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER /DIR=$install /LOG=$log"
    $info.UseShellExecute = $false
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $process = [System.Diagnostics.Process]::Start($info)
    $process.WaitForExit()
    $clock.Stop()
    Write-Host "::group::setup log: $Label (exit code $($process.ExitCode), $([int]$clock.Elapsed.TotalSeconds) s)"
    if (Test-Path -LiteralPath $log) {
        Get-Content -LiteralPath $log | Where-Object { $_ -match 'release-folder|PrepareToInstall|Setup stopped|Installing to|exit code' } | ForEach-Object { Write-Host $_ }
    } else {
        Write-Host 'no log was written'
    }
    Write-Host '::endgroup::'
    return [pscustomobject]@{ Code = $process.ExitCode; Seconds = $clock.Elapsed.TotalSeconds; Log = $log }
}

function Get-LogText {
    param($Run)
    if (Test-Path -LiteralPath $Run.Log) { return (Get-Content -LiteralPath $Run.Log -Raw) }
    return ''
}

# A program that does nothing, started from $Exe, whose handle we keep.
function Start-StandIn {
    param([string]$Exe)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Exe
    $info.Arguments = '-e setInterval(()=>{},1000)'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($info)
}

function Stop-OurStandIn {
    param($Process)
    if ($Process -and -not $Process.HasExited) {
        $Process.Kill()
        $Process.WaitForExit(10000) | Out-Null
    }
}

# Opens a file for writing with no sharing, as the helper's probe does. Tries for a
# few seconds, as something that has just left (the runner start that setup
# ends with, a scanner) may still have it.
function Open-Exclusive {
    param([string]$Path)
    $deadline = (Get-Date).AddSeconds(30)
    while ($true) {
        try {
            return [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
        } catch {
            if ((Get-Date) -gt $deadline) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Test-Exclusive {
    param([string]$Path)
    try {
        $stream = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
        $stream.Dispose()
        return $true
    } catch {
        return $false
    }
}

# WebView2 is what the setup looks for first and refuses without. Hosted runners
# are not guaranteed to have it, and nothing here opens a window, so a stand-in
# record is made where the setup looks, on this throwaway machine only.
function Initialize-WebView2 {
    $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $places = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id"
    )
    foreach ($place in $places) {
        if (Test-Path -LiteralPath $place) {
            $version = (Get-ItemProperty -LiteralPath $place -Name pv -ErrorAction SilentlyContinue).pv
            if ($version -and $version -ne '0.0.0.0') {
                Write-Host "WebView2 $version is installed on this runner."
                return
            }
        }
    }
    Write-Host 'WebView2 is not on this runner: writing the record the setup looks for, so it gets as far as the upgrade.'
    New-Item -Path $places[0] -Force | Out-Null
    Set-ItemProperty -LiteralPath $places[0] -Name pv -Value '1.0.0.0'
}

$started = @()
$handle = $null
try {
    Initialize-WebView2

    # ---- 1. a fresh install
    $first = Invoke-Setup 'install-1-fresh'
    Assert-That ($first.Code -eq 0) "the fresh install exits 0 (it exited $($first.Code))"
    Assert-That (Test-Path -LiteralPath $nodeExe) 'it put node.exe in place'
    Assert-That (Test-Path -LiteralPath (Join-Path $install 'Threadbear.exe')) 'and Threadbear.exe'

    # ---- 2. node.exe is running from the install folder
    New-Item -ItemType File -Force $marker -Value 'left over from the earlier install' | Out-Null
    foreach ($copy in @($otherDir, $lookalikeDir)) {
        New-Item -ItemType Directory -Force (Join-Path $copy 'node') | Out-Null
        Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $copy 'node\node.exe')
    }
    $holder = Start-StandIn $nodeExe
    $started += $holder
    $controlOther = Start-StandIn (Join-Path $otherDir 'node\node.exe')
    $started += $controlOther
    $controlLookalike = Start-StandIn (Join-Path $lookalikeDir 'node\node.exe')
    $started += $controlLookalike
    Start-Sleep -Seconds 3
    Assert-That (-not $holder.HasExited) 'the program running from the install folder is up'
    Assert-That (-not (Test-Exclusive $nodeExe)) 'and it stops node.exe being opened for writing (the lock is real)'

    $second = Invoke-Setup 'install-2-over-a-running-node'
    $log = Get-LogText $second
    Assert-That ($second.Code -eq 0) "the upgrade over a running node.exe exits 0 (it exited $($second.Code))"
    Assert-That ($holder.WaitForExit(10000)) 'the program that held node.exe was ended'
    Assert-That (-not $controlOther.HasExited) 'the copy of node.exe in another folder was left running'
    Assert-That (-not $controlLookalike.HasExited) 'and so was the one in Threadbear2'
    Assert-That (-not (Test-Path -LiteralPath $marker)) 'the runner folder was rebuilt (the marker from the earlier install is gone)'
    Assert-That ($log -match "release-folder: PROC\|$($holder.Id)\|") 'the setup log lists the holder by its process number'
    Assert-That ($log -match "release-folder: ENDED\|$($holder.Id)\b") 'and says it ended it'
    Assert-That ($log -notmatch "release-folder: ENDED\|($($controlOther.Id)|$($controlLookalike.Id))\b") 'and not the controls'
    $nodeVersion = & $nodeExe --version
    Assert-That ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v\d+\.') "the node.exe that is there now runs ($nodeVersion)"
    Assert-That (Test-Path -LiteralPath (Join-Path $install 'unins000.exe')) 'and the install is complete (the uninstaller is there)'

    # ---- 3. node.exe is held, but not by a program running from the folder
    New-Item -ItemType File -Force $marker -Value 'left over from the earlier install' | Out-Null
    $handle = Open-Exclusive $nodeExe
    $third = Invoke-Setup 'install-3-file-held'
    $log = Get-LogText $third
    Assert-That ($third.Code -eq 7) "with node.exe held by something else, Setup stops with exit code 7 (it exited $($third.Code))"
    Assert-That ($third.Seconds -ge 18) "after waiting for it (it took $([int]$third.Seconds) s)"
    Assert-That ($log -match 'PrepareToInstall failed') 'the log says why'
    Assert-That (Test-Path -LiteralPath $marker) 'and the old install is untouched: [InstallDelete] had not run'
    Assert-That (Test-Path -LiteralPath $nodeExe) 'node.exe is still there'
    Assert-That (-not $controlOther.HasExited -and -not $controlLookalike.HasExited) 'and the controls are still running'

    $handle.Dispose()
    $handle = $null
    $fourth = Invoke-Setup 'install-4-free-again'
    Assert-That ($fourth.Code -eq 0) "once it is let go, the upgrade goes through (exit code $($fourth.Code))"
    Assert-That (-not (Test-Path -LiteralPath $marker)) 'and rebuilds the runner folder'
} catch {
    Write-Host "::error::$($_.Exception.Message)"
    foreach ($file in Get-ChildItem -LiteralPath $WorkDir -Filter '*.log' -ErrorAction SilentlyContinue) {
        Write-Host "::group::$($file.Name)"
        Get-Content -LiteralPath $file.FullName | Write-Host
        Write-Host '::endgroup::'
    }
    $failed = $true
} finally {
    if ($handle) { $handle.Dispose() }
    foreach ($process in $started) { Stop-OurStandIn $process }
    # Take the install off again. The uninstaller asks the app to quit and ends the
    # runner's task, as it does on any PC.
    $uninstaller = Join-Path $install 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $uninstaller
        $info.Arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
        $info.UseShellExecute = $false
        $removal = [System.Diagnostics.Process]::Start($info)
        $removal.WaitForExit(120000) | Out-Null
        Write-Host "The uninstaller exited with $($removal.ExitCode)."
    }
}

if ($failed) { exit 1 }
Write-Host 'The setup waited for node.exe, ended only what was in the way, and refused cleanly when it could not.'
