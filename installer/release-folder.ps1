# Looks at the install folder for the setup exe (threadbear.iss), and can end
# what is holding it. Setup carries this file inside itself, extracts it to its
# temporary folder and runs it with Windows PowerShell 5.1:
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File release-folder.ps1
#       -Action <Probe|List|Wait|End> -Folder <install folder> [-OutFile <report>]
#       [-Seconds <n>] [-Expect <pid:start,pid:start>]
#
#   Probe  Can node\node.exe and Threadbear.exe be opened for writing with no
#          sharing? Reads nothing else.
#   List   Probe, then list the programs whose file is inside the folder.
#   Wait   Probe again every half second for -Seconds, and when something still
#          holds the folder at the end, list the programs too.
#   End    End the programs named by -Expect, each only if it still passes every
#          check below. -Expect is what a List or Wait showed: pid:start pairs.
#
# Everything but End only looks. It reads the process table (CIM, as wmic is
# gone from current Windows 11) and opens the two files without writing to them.
#
# A rename is not a way to test for a lock: a running exe can be renamed on NTFS,
# so a probe that renamed would call a held node.exe free. Opening it for write
# with sharing off is refused while it runs, which is what stops a file being
# replaced.
#
# Ending a program is by process number only, never by image name, and never
# with its children (a dev server on the system Node, started from a thread, is
# not ours to end). A program is ended only when, read afresh just before:
#   - its file is inside the folder, under one of the parts setup replaces
#     ($script:ManagedFolders and $script:ManagedFiles below), so a folder that is
#     shared with other programs, or a drive root, never has them ended;
#   - it belongs to the user running setup (the owner's SID matches);
#   - it is not setup itself or anything setup was started from;
#   - its start time can be read, and is the one that was listed, so a process
#     number that has been reused since is left alone.
# A start time or owner that cannot be read means leave it.
#
# The report (-OutFile, UTF-8) is one fact per line, fields split by "|":
#   REPORT|1
#   STATE|free|held|unknown        (Probe, List, Wait)
#   FILE|<state>|<path>            state: free, held, absent, denied or error
#   PROC|<pid>|<parent>|<start>|<name>|<end or keep:reason>|<file>|<command line>
#   NOTE|<text>   ERROR|<text>
#   ENDED|<pid>   SKIPPED|<pid>|<reason>   GONE|<pid>   FAILED|<pid>|<why>   (End)
# Exit codes: 10 free, 11 held, 12 could not tell (Probe, List, Wait); 0 for End
# when it ran. Any other code, including PowerShell's own 1 for a blocked
# script, means the helper did not run, and setup carries on without it.
#
# Keep this file ASCII: Windows PowerShell reads a script with no byte order
# mark in the system code page, not UTF-8.

param(
    [string]$Action = '',
    [string]$Folder = '',
    [string]$OutFile = '',
    [int]$Seconds = 0,
    [string]$Expect = ''
)

# What setup puts in the install folder and replaces on an upgrade. Keep in step
# with [InstallDelete] in threadbear.iss (the test for this file checks it).
$script:ManagedFolders = @('node', 'runner', 'desktop', 'docs')
$script:ManagedFiles = @('Threadbear.exe')
# The two files whose being held stops an upgrade: the shell, and the Node the
# runner, the bridge and everything started from them run on.
$script:Probed = @('node\node.exe', 'Threadbear.exe')

# ------------------------------------------------------------- path rules

# The folder as a full path with one trailing backslash, so that
# C:\Apps\Threadbear\ is a prefix of C:\Apps\Threadbear\node\node.exe and not of
# C:\Apps\Threadbear2\node\node.exe or C:\Apps\Threadbearnodes.exe.
function Get-FolderPrefix {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.TrimEnd('\', '/') + '\'
}

# True for C:\ and \\server\share: where every program on the drive would be
# "inside the folder".
function Test-RootFolder {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    return $full.TrimEnd('\', '/') -ieq $root.TrimEnd('\', '/')
}

# Windows paths ignore case. Ordinal, so the language the PC is set to (Turkish
# i) cannot change the answer.
function Test-UnderFolder {
    param([string]$Path, [string]$Prefix)
    if ([string]::IsNullOrEmpty($Path)) { return $false }
    return $Path.StartsWith($Prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

# Under the folder and one of the parts setup replaces: Threadbear.exe itself, or
# anything inside node\, runner\, desktop\ or docs\.
function Test-ManagedPath {
    param([string]$Path, [string]$Prefix)
    if (-not (Test-UnderFolder $Path $Prefix)) { return $false }
    $relative = $Path.Substring($Prefix.Length)
    $slash = $relative.IndexOf('\')
    if ($slash -lt 0) { return $script:ManagedFiles -contains $relative }
    return $script:ManagedFolders -contains $relative.Substring(0, $slash)
}

# Two SIDs (or any two account names) are the same account. Unknown on either
# side is not the same.
function Test-SameOwner {
    param([string]$Owner, [string]$Me)
    if ([string]::IsNullOrEmpty($Owner) -or [string]::IsNullOrEmpty($Me)) { return $false }
    return $Owner -ieq $Me
}

# ---------------------------------------------------------- the files

# 'free' (opened for writing with no sharing, then closed, nothing written),
# 'held' (another program has it open or running), 'absent', 'denied' (not
# allowed to write it, which is a permissions matter and not a lock), or 'error'.
function Test-FileHeld {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'absent' }
    $stream = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        return 'free'
    } catch {
        # Called from PowerShell, the real exception is wrapped in one of its own.
        $e = $_.Exception
        if ($e.InnerException) { $e = $e.InnerException }
        if ($e -is [System.UnauthorizedAccessException]) { return 'denied' }
        if ($e -is [System.IO.FileNotFoundException] -or $e -is [System.IO.DirectoryNotFoundException]) { return 'absent' }
        if ($e -is [System.IO.IOException]) {
            # 32 is a sharing violation and 33 a lock violation.
            $code = $e.HResult -band 0xFFFF
            if ($code -eq 32 -or $code -eq 33) { return 'held' }
        }
        return 'error'
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Get-FolderFiles {
    param([string]$Path)
    $files = @()
    foreach ($relative in $script:Probed) {
        $file = [System.IO.Path]::Combine($Path, $relative)
        $files += [pscustomobject]@{ Path = $file; State = (Test-FileHeld $file) }
    }
    return $files
}

# held if any file is, else unknown if any could not be tried, else free.
function Get-FolderState {
    param($Files)
    $states = @($Files | ForEach-Object { $_.State })
    if ($states -contains 'held') { return 'held' }
    if ($states -contains 'error') { return 'unknown' }
    return 'free'
}

# --------------------------------------------------------- the programs

function Get-ProcessTable {
    return @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 15 -ErrorAction Stop)
}

# The numbers of the process this is running as and every program it was started
# from (setup, and what started setup). $Table is the process table.
function Get-AncestorIds {
    param($Table, [int]$StartPid = $PID)
    $parentOf = @{}
    foreach ($p in $Table) { $parentOf[[int]$p.ProcessId] = [int]$p.ParentProcessId }
    $ids = @{}
    $current = $StartPid
    while ($current -gt 0 -and -not $ids.ContainsKey($current)) {
        $ids[$current] = $true
        if (-not $parentOf.ContainsKey($current)) { break }
        $current = $parentOf[$current]
    }
    return $ids
}

# A start time as a Windows file time (100 ns since 1601, UTC), the count the
# runner keeps for its own processes. $null when it cannot be read.
function Get-StartTime {
    param($Cim)
    try {
        if ($Cim.CreationDate) { return [string]$Cim.CreationDate.ToFileTimeUtc() }
    } catch { }
    return $null
}

# The SID of the account a process runs as, or $null when Windows will not say.
function Get-OwnerSid {
    param($Cim)
    try {
        $result = Invoke-CimMethod -InputObject $Cim -MethodName GetOwnerSid -ErrorAction Stop
        if ($result -and $result.ReturnValue -eq 0 -and $result.Sid) { return [string]$result.Sid }
    } catch { }
    return $null
}

function ConvertTo-ProcessRecord {
    param($Cim)
    return [pscustomobject]@{
        Pid     = [int]$Cim.ProcessId
        Parent  = [int]$Cim.ParentProcessId
        Name    = [string]$Cim.Name
        Path    = [string]$Cim.ExecutablePath
        Command = [string]$Cim.CommandLine
        Start   = (Get-StartTime $Cim)
        Owner   = (Get-OwnerSid $Cim)
    }
}

function New-Context {
    param([string]$Path, $Table)
    return @{
        Prefix     = (Get-FolderPrefix $Path)
        RootFolder = (Test-RootFolder $Path)
        Me         = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        Own        = (Get-AncestorIds $Table)
    }
}

# 'end' when a program is ours to end, else 'keep:' and the first reason it is
# not. $Proc has Pid, Path, Start and Owner (as ConvertTo-ProcessRecord gives).
function Get-Verdict {
    param($Proc, $Context)
    if ($Context.RootFolder) { return 'keep:root-folder' }
    if ($Context.Own.ContainsKey([int]$Proc.Pid)) { return 'keep:setup-itself' }
    if (-not (Test-UnderFolder $Proc.Path $Context.Prefix)) { return 'keep:outside-folder' }
    if (-not (Test-ManagedPath $Proc.Path $Context.Prefix)) { return 'keep:not-part-of-install' }
    if (-not $Proc.Start) { return 'keep:start-time-unreadable' }
    if (-not (Test-SameOwner $Proc.Owner $Context.Me)) { return 'keep:other-owner' }
    return 'end'
}

# The programs whose file is inside the folder, oldest first (a parent starts
# before its children, and the supervisor has to go before the runner it would
# otherwise start again), each with its verdict.
function Get-Holders {
    param($Table, $Context)
    $found = @()
    foreach ($cim in $Table) {
        if (-not (Test-UnderFolder ([string]$cim.ExecutablePath) $Context.Prefix)) { continue }
        $record = ConvertTo-ProcessRecord $cim
        $record | Add-Member -NotePropertyName Verdict -NotePropertyValue (Get-Verdict $record $Context)
        $found += $record
    }
    return @($found | Sort-Object -Property @{ Expression = { if ($_.Start) { [int64]$_.Start } else { 0 } } })
}

# ----------------------------------------------------------- the report

# One line's worth: no line breaks and no bar, which splits fields.
function Format-Field {
    param($Text, [int]$Max = 0)
    $s = ([string]$Text) -replace '[\r\n|]+', ' '
    if ($Max -gt 0 -and $s.Length -gt $Max) { $s = $s.Substring(0, $Max) + '...' }
    return $s
}

function Get-HolderLines {
    param([string]$Path)
    $table = Get-ProcessTable
    $context = New-Context $Path $table
    $lines = @()
    foreach ($h in (Get-Holders $table $context)) {
        $lines += 'PROC|{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f $h.Pid, $h.Parent, $h.Start, (Format-Field $h.Name), $h.Verdict, (Format-Field $h.Path), (Format-Field $h.Command 400)
    }
    return $lines
}

function Get-FileLines {
    param($Files)
    $lines = @()
    foreach ($f in $Files) { $lines += 'FILE|{0}|{1}' -f $f.State, (Format-Field $f.Path) }
    return $lines
}

# ------------------------------------------------------------- ending

# One program from an -Expect list. Everything is read again here, so what was
# true when it was listed does not have to be true now. Returns the report line.
function Stop-Expected {
    param($Pair, $Context)
    $cim = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$Pair.Pid) -OperationTimeoutSec 15 -ErrorAction Stop
    if (-not $cim) { return 'GONE|' + $Pair.Pid }
    $record = ConvertTo-ProcessRecord $cim
    $verdict = Get-Verdict $record $Context
    if ($verdict -ne 'end') { return 'SKIPPED|' + $Pair.Pid + '|' + $verdict }
    if ($record.Start -ne $Pair.Start) { return 'SKIPPED|' + $Pair.Pid + '|keep:start-time-changed' }
    # By number, and not /T: what it started is not ours to end.
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $ended = Start-Process -FilePath $taskkill -ArgumentList @('/PID', [string]$record.Pid, '/F') -Wait -PassThru -WindowStyle Hidden
    if ($ended.ExitCode -ne 0) { return 'FAILED|' + $Pair.Pid + '|taskkill exit code ' + $ended.ExitCode }
    return 'ENDED|' + $Pair.Pid
}

function ConvertFrom-Expect {
    param([string]$Text)
    $pairs = @()
    foreach ($item in ($Text -split ',')) {
        if ($item.Trim() -match '^(\d+):(\d+)$') {
            $pairs += [pscustomobject]@{ Pid = [int]$Matches[1]; Start = $Matches[2] }
        }
    }
    return @($pairs | Sort-Object -Property @{ Expression = { [int64]$_.Start } })
}

# --------------------------------------------------------------- main

function Invoke-Main {
    $lines = @('REPORT|1')
    $code = 12
    try {
        $ErrorActionPreference = 'Stop'
        if (-not $Folder) { throw 'no -Folder given' }
        switch ($Action) {
            'Probe' {
                $files = @(Get-FolderFiles $Folder)
                $state = Get-FolderState $files
                $lines += "STATE|$state"
                $lines += @(Get-FileLines $files)
                $code = @{ free = 10; held = 11; unknown = 12 }[$state]
            }
            { $_ -eq 'List' -or $_ -eq 'Wait' } {
                $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $Seconds))
                if ($Action -eq 'List') { $deadline = [DateTime]::UtcNow }
                while ($true) {
                    $files = @(Get-FolderFiles $Folder)
                    $state = Get-FolderState $files
                    if ($state -ne 'held' -or [DateTime]::UtcNow -ge $deadline) { break }
                    Start-Sleep -Milliseconds 500
                }
                $lines += "STATE|$state"
                $lines += @(Get-FileLines $files)
                if ($state -eq 'held' -or $Action -eq 'List') {
                    try {
                        $lines += @(Get-HolderLines $Folder)
                    } catch {
                        $lines += 'NOTE|the programs could not be listed: ' + (Format-Field $_.Exception.Message)
                    }
                }
                $code = @{ free = 10; held = 11; unknown = 12 }[$state]
            }
            'End' {
                $table = Get-ProcessTable
                $context = New-Context $Folder $table
                foreach ($pair in (ConvertFrom-Expect $Expect)) {
                    try {
                        $lines += Stop-Expected $pair $context
                    } catch {
                        $lines += 'FAILED|' + $pair.Pid + '|' + (Format-Field $_.Exception.Message)
                    }
                }
                $code = 0
            }
            default { throw "unknown -Action '$Action'" }
        }
    } catch {
        $lines += 'STATE|unknown'
        $lines += 'ERROR|' + (Format-Field $_.Exception.Message)
        $code = 12
    }
    if ($OutFile) {
        Set-Content -LiteralPath $OutFile -Value $lines -Encoding UTF8
    } else {
        foreach ($line in $lines) { Write-Host $line }
    }
    return $code
}

# Dot-sourced with no -Action (the tests do), this only defines the functions.
if ($Action) { exit (Invoke-Main) }
