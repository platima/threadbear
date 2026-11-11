# Looks at the install folder for the setup exe (threadbear.iss), and can end
# what is holding it. Setup carries this file inside itself, extracts it to its
# temporary folder and runs it with Windows PowerShell 5.1:
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File release-folder.ps1
#       -Action <Probe|List|Wait|End|Owner> -Folder <install folder> [-OutFile <report>]
#       [-Seconds <n>] [-Expect <pid:start,pid:start>] [-OwnerSid <sid>] [-Marker <text>]
#
#   Probe  Can node\node.exe and Threadbear.exe be opened for writing with no
#          sharing? Reads nothing else.
#   List   Probe, then list the programs whose file is inside the folder.
#   Wait   Probe again every half second for -Seconds, and when something still
#          holds the folder at the end, list the programs too.
#   End    End the programs named by -Expect, each only if it still passes every
#          check below. -Expect is what a List or Wait showed: pid:start pairs.
#   Owner  Say whose account runs the one program with -Marker in its command
#          line (no -Folder needed): how setup learns who started it, when it was
#          elevated as another account (see -OwnerSid).
#
# -OwnerSid is the account whose programs may be ended: the user who started
# Setup, as setup found out (the Owner action). Given, it is the owner for List and
# Wait (what is listed as ours to end) and for End alike; not given, it is whoever
# runs this script. It has to look like a SID, or nothing is done.
#
# The folder is held when either file is, and also when a program is running whose
# file is any part of the install that setup replaces (see below), as its being
# deleted fails just the same: an OpenConsole.exe under desktop\node_modules that
# outlived the app, say, with both files free. List and Wait look for that; Probe
# does not, as it reads nothing but the two files.
#
# Everything but End only looks. It reads the process table (CIM, as wmic is
# gone from current Windows 11) and opens the two files without writing to them.
#
# A rename is not a way to test for a lock: a running exe can be renamed on NTFS,
# so a probe that renamed would call a held node.exe free. Opening it for write
# with sharing off is refused while it runs, which is what stops a file being
# replaced.
#
# Ending a program is by one process only (see below), never by image name, and
# never with its children (a dev server on the system Node, started from a thread,
# is not ours to end). A program is ended only when, read afresh just before:
#   - the folder is a Threadbear install (Threadbear.exe is in it) and not one
#     that other programs share: a drive root, Program Files, Windows, ProgramData,
#     a profile and its Desktop, Documents and Downloads, and any folder named
#     like those (Test-SharedFolder). Nothing in such a folder is ended, whoever
#     says so, and setup does not install into one;
#   - its file is inside the folder, under one of the parts setup replaces
#     ($script:ManagedFolders and $script:ManagedFiles below);
#   - it belongs to the user who started setup (the owner's SID matches);
#   - it is not setup itself or anything setup was started from;
#   - its start time can be read, and is the one that was listed, so a process
#     number that has been reused since is left alone.
# A start time or owner that cannot be read means leave it.
#
# What is ended is the process itself and not a number. The number could be given to
# another program between the checks and the end: it is the very process that was
# listed that must be the one ended, so End opens a handle to it first (which keeps
# the number from being given to anything else while the handle is open), checks
# the start time through that handle and the rest against it, and ends it through
# that same handle. That needs .NET calls, which Constrained Language Mode refuses
# (and Add-Type, the other way to a handle, as well): then nothing is ended, and
# the report says so, and setup carries on as when the helper does not run.
#
# The report (-OutFile, UTF-8) is one fact per line, fields split by "|":
#   REPORT|1
#   STATE|free|held|unknown        (Probe, List, Wait)
#   FILE|<state>|<path>            state: free, held, absent, denied or error
#   PROC|<pid>|<parent>|<start>|<name>|<end or keep:reason>|<file>|<command line>
#   NOTE|<text>   ERROR|<text>
#   ENDED|<pid>   SKIPPED|<pid>|<reason>   GONE|<pid>   FAILED|<pid>|<why>   (End)
#   OWNER|<sid>                     (Owner, when exactly one program has the marker)
# Exit codes: 10 free, 11 held, 12 could not tell (Probe, List, Wait); 0 for End
# when it ran, and for Owner whether or not it found one. 12 for anything any of
# them could not do, End and Owner included (STATE|unknown and an ERROR line). Any
# other code, including PowerShell's own 1 for a blocked script, means the helper
# did not run, and setup carries on without it.
#
# Keep this file ASCII: Windows PowerShell reads a script with no byte order
# mark in the system code page, not UTF-8.

param(
    [string]$Action = '',
    [string]$Folder = '',
    [string]$OutFile = '',
    [int]$Seconds = 0,
    [string]$Expect = '',
    [string]$OwnerSid = '',
    [string]$Marker = ''
)

# What setup puts in the install folder and replaces on an upgrade. Keep in step
# with [InstallDelete] in threadbear.iss (the test for this file checks it).
$script:ManagedFolders = @('node', 'runner', 'desktop', 'docs')
$script:ManagedFiles = @('Threadbear.exe')
# The two files whose being held stops an upgrade: the shell, and the Node the
# runner, the bridge and everything started from them run on.
$script:Probed = @('node\node.exe', 'Threadbear.exe')
# Folders that hold other programs' files, so that no install folder is one of them
# and nothing in one is ended. These names are shared wherever they are (D:\Program
# Files as much as C:\), and ProfileShared are the folders in a profile that are
# (C:\Users\<anyone>\Downloads). Keep in step with SharedNames and ProfileShared in
# threadbear.iss (the test for this file checks it).
$script:SharedNames = @('Program Files', 'Program Files (x86)', 'Program Files (Arm)', 'Common Files', 'Windows', 'WindowsApps', 'ProgramData', 'Users')
$script:ProfileShared = @('Desktop', 'Documents', 'Downloads', 'AppData')
# How far apart, in 100 ns units, two readings of one program's start time may be.
# The process table keeps microseconds and a handle 100 ns, so the same program is
# 0 to 9 apart. A number is reused by a program that started a good deal later than
# a millisecond after the old one did.
$script:StartTolerance = 10000

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

# The folders Windows names for every program's use, from the environment and from
# Windows itself: Program Files (each of them), Windows, ProgramData, the profile
# and its shell folders, the folder profiles are in, and the per-user Programs.
# Read each time, so what the environment says now is what counts.
function Get-KnownSharedFolders {
    $found = @()
    foreach ($name in @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramFiles(Arm)', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'SystemRoot', 'windir', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA')) {
        $value = [System.Environment]::GetEnvironmentVariable($name)
        if ($value) { $found += $value }
    }
    foreach ($name in @('ProgramFiles', 'ProgramFilesX86', 'CommonProgramFiles', 'CommonProgramFilesX86', 'Windows', 'System', 'CommonApplicationData', 'ApplicationData', 'LocalApplicationData', 'UserProfile', 'Desktop', 'DesktopDirectory', 'MyDocuments', 'CommonDesktopDirectory', 'CommonDocuments')) {
        try {
            $value = [System.Environment]::GetFolderPath($name)
            if ($value) { $found += $value }
        } catch { }
    }
    $profile = [System.Environment]::GetEnvironmentVariable('USERPROFILE')
    if ($profile) {
        $found += [System.IO.Path]::GetDirectoryName($profile.TrimEnd('\', '/'))
        foreach ($shell in $script:ProfileShared) { $found += (Join-Path $profile $shell) }
    }
    $local = [System.Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if ($local) { $found += (Join-Path $local 'Programs') }
    foreach ($name in @('ProgramFiles', 'ProgramW6432')) {
        $value = [System.Environment]::GetEnvironmentVariable($name)
        if ($value) { $found += (Join-Path $value 'WindowsApps') }
    }
    return @($found | Where-Object { $_ })
}

# True for a folder that other programs share, which is never an install folder:
# one of the known bases (Get-KnownSharedFolders), one with a shared name wherever
# it is ($script:SharedNames), or a profile in the folder that profiles are in
# (C:\Users\<anyone>, and its Desktop, Documents, Downloads and AppData, whoever's).
function Test-SharedFolder {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($script:SharedNames -contains [System.IO.Path]::GetFileName($full)) { return $true }
    foreach ($known in (Get-KnownSharedFolders)) {
        try { $base = [System.IO.Path]::GetFullPath($known).TrimEnd('\', '/') } catch { continue }
        if ($full -ieq $base) { return $true }
    }
    $profile = [System.Environment]::GetEnvironmentVariable('USERPROFILE')
    if ($profile) {
        $users = [System.IO.Path]::GetDirectoryName($profile.TrimEnd('\', '/'))
        # Not when profiles sit in a drive root, where every folder on the drive would be one.
        if ($users -and -not (Test-RootFolder $users)) {
            $users = $users.TrimEnd('\', '/')
            if (Test-UnderFolder $full ($users + '\')) {
                $parts = @($full.Substring($users.Length + 1).Split('\'))
                if ($parts.Count -eq 1) { return $true }
                if ($parts.Count -eq 2 -and ($script:ProfileShared -contains $parts[1])) { return $true }
                if ($parts.Count -eq 3 -and $parts[1] -ieq 'AppData' -and (@('Local', 'LocalLow', 'Roaming') -contains $parts[2])) { return $true }
            }
        }
    }
    return $false
}

# Why a folder is not one that anything is ended in: 'root-folder' (a drive or a
# share), 'shared-folder' (Test-SharedFolder), or '' when it may be an install.
function Get-FolderRefusal {
    param([string]$Path)
    if (Test-RootFolder $Path) { return 'root-folder' }
    if (Test-SharedFolder $Path) { return 'shared-folder' }
    return ''
}

# Two readings of when a program started (Windows file times) are the same
# program's when they agree to $script:StartTolerance. Either one unreadable is not.
function Test-SameStart {
    param([string]$A, [string]$B)
    $x = [int64]0
    $y = [int64]0
    if (-not ([int64]::TryParse($A, [ref]$x) -and [int64]::TryParse($B, [ref]$y))) { return $false }
    return [Math]::Abs($x - $y) -lt $script:StartTolerance
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

# What is known about the folder and who is asking, which every verdict needs:
# Prefix (the folder with a trailing backslash), Refusal ('root-folder',
# 'shared-folder' or '': nothing is ended in a folder that has one), Installed
# (Threadbear.exe is in it, which is what makes it an install), Me (the SID of the
# account whose programs may be ended: $Owner, the user who started setup, when it
# is given, else the account running this) and Own (setup and what started it).
function New-Context {
    param([string]$Path, $Table, [string]$Owner = '')
    $me = $Owner
    if (-not $me) { $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    return @{
        Prefix    = (Get-FolderPrefix $Path)
        Refusal   = (Get-FolderRefusal $Path)
        Installed = (Test-Path -LiteralPath (Join-Path $Path 'Threadbear.exe') -PathType Leaf)
        Me        = $me
        Own       = (Get-AncestorIds $Table)
    }
}

# 'end' when a program is ours to end, else 'keep:' and the first reason it is
# not. $Proc has Pid, Path, Start and Owner (as ConvertTo-ProcessRecord gives).
function Get-Verdict {
    param($Proc, $Context)
    if ($Context.Refusal) { return 'keep:' + $Context.Refusal }
    if ($Context.Own.ContainsKey([int]$Proc.Pid)) { return 'keep:setup-itself' }
    if (-not (Test-UnderFolder $Proc.Path $Context.Prefix)) { return 'keep:outside-folder' }
    if (-not (Test-ManagedPath $Proc.Path $Context.Prefix)) { return 'keep:not-part-of-install' }
    # Unknown folders are not told apart from a Threadbear install by their node folder.
    if (-not $Context.Installed) { return 'keep:not-an-install' }
    if (-not $Proc.Start) { return 'keep:start-time-unreadable' }
    if (-not (Test-SameOwner $Proc.Owner $Context.Me)) { return 'keep:other-owner' }
    return 'end'
}

# The programs whose file is inside the folder, oldest first (a parent starts
# before its children, and the supervisor has to go before the runner it would
# otherwise start again), each with its verdict. None for a folder that is refused
# (Refusal), where "inside the folder" is every program on a drive or a PC.
function Get-Holders {
    param($Table, $Context)
    if ($Context.Refusal) { return @() }
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

# True when a program is running whose file is a part of the install that setup
# replaces (Test-ManagedPath), whether or not it has either probed file open.
# Setup itself and what it was started from are counted too, though they are never
# ended (Get-Verdict): a program run from desktop\ or runner\ that started setup
# has its file open just the same, and deleting that folder fails on it. A folder
# that is refused (a drive root, a shared folder) has no such programs, as with
# Get-Holders.
function Test-ManagedInUse {
    param([string]$Path, [string]$Owner = '')
    $table = Get-ProcessTable
    $context = New-Context $Path $table $Owner
    if ($context.Refusal) { return $false }
    foreach ($cim in $table) {
        if (Test-ManagedPath ([string]$cim.ExecutablePath) $context.Prefix) { return $true }
    }
    return $false
}

function Get-HolderLines {
    param([string]$Path, [string]$Owner = '')
    $table = Get-ProcessTable
    $context = New-Context $Path $table $Owner
    $lines = @()
    if ($context.Refusal) {
        return @('NOTE|' + (Format-Field ($Path + ' is shared with other programs (' + $context.Refusal + '), so nothing running from it is listed or ended')))
    }
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

# A handle to the program with this number, opened now and kept (the Process object
# holds it until it is disposed). $null when nothing is running with that number.
# While the handle is open the number cannot be given to another program, so the
# number means this one program from here on, whether it exits or not. A number
# given to another program before the handle was opened is found out by comparing
# start times (Stop-Expected). Throws when the handle cannot be had (access refused,
# or the .NET calls are not allowed).
function Open-PinnedProcess {
    param([int]$ProcessId)
    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    } catch {
        # Called from PowerShell, the real exception is wrapped in one of its own.
        $e = $_.Exception
        if ($e.InnerException) { $e = $e.InnerException }
        if ($e -is [System.ArgumentException]) { return $null }
        throw
    }
    try {
        # Opens the handle now, with the access to read it and to end it. A program
        # that has just gone is Win32 error 87.
        $null = $proc.Handle
    } catch {
        $e = $_.Exception
        if ($e.InnerException) { $e = $e.InnerException }
        $proc.Dispose()
        if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 87) { return $null }
        throw
    }
    return $proc
}

# One program from an -Expect list. It is the program that was listed, and not
# whatever has the number now, that is ended: a handle is opened first (see
# Open-PinnedProcess), the start time is read through that handle and has to be the
# listed one, everything else is read afresh while the handle is held (so about
# this very program), and it is ended through the handle. Returns the report line.
function Stop-Expected {
    param($Pair, $Context)
    $proc = Open-PinnedProcess ([int]$Pair.Pid)
    if (-not $proc) { return 'GONE|' + $Pair.Pid }
    try {
        $handleStart = [string]$proc.StartTime.ToFileTimeUtc()
        if (-not (Test-SameStart $handleStart $Pair.Start)) { return 'SKIPPED|' + $Pair.Pid + '|keep:start-time-changed' }
        $cim = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$Pair.Pid) -OperationTimeoutSec 15 -ErrorAction Stop
        if (-not $cim) {
            if ($proc.HasExited) { return 'GONE|' + $Pair.Pid }
            return 'SKIPPED|' + $Pair.Pid + '|keep:not-readable'
        }
        $record = ConvertTo-ProcessRecord $cim
        if (-not (Test-SameStart $record.Start $handleStart)) { return 'SKIPPED|' + $Pair.Pid + '|keep:start-time-changed' }
        $verdict = Get-Verdict $record $Context
        if ($verdict -ne 'end') { return 'SKIPPED|' + $Pair.Pid + '|' + $verdict }
        # This process only, and not what it started, which is not ours to end.
        try {
            $proc.Kill()
        } catch {
            # Gone between the check and now (an exiting program refuses to be ended again).
            if ($proc.HasExited) { return 'GONE|' + $Pair.Pid }
            throw
        }
        if (-not $proc.WaitForExit(5000)) { return 'FAILED|' + $Pair.Pid + '|still running 5 seconds after it was ended' }
        return 'ENDED|' + $Pair.Pid
    } finally {
        $proc.Dispose()
    }
}

# Whose account runs the one program, other than this one and what started it,
# with $Marker in its command line: the SID, or $null when no program has it or more
# than one does (which of them is the user's is not known then). What setup starts
# as the user who started it, to ask them this.
function Find-MarkerOwner {
    param([string]$Text)
    $table = Get-ProcessTable
    $own = Get-AncestorIds $table
    $carrying = @($table | Where-Object {
            $command = [string]$_.CommandLine
            ($command.IndexOf($Text, [System.StringComparison]::Ordinal) -ge 0) -and -not $own.ContainsKey([int]$_.ProcessId)
        })
    if ($carrying.Count -ne 1) { return $null }
    return (Get-OwnerSid $carrying[0])
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
        if (-not $Folder -and $Action -ne 'Owner') { throw 'no -Folder given' }
        # A SID is S-1-<authority>-<subauthority>...; anything else is not what setup was given by Windows.
        if ($OwnerSid -and $OwnerSid -notmatch '^S-1-[0-9]+(-[0-9]+)+$') { throw '-OwnerSid is not a SID' }
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
                $notes = @()
                while ($true) {
                    $files = @(Get-FolderFiles $Folder)
                    $state = Get-FolderState $files
                    # Both files can be opened, but another part of the install may be running.
                    # If the programs cannot be read the answer is the files', as before.
                    if ($state -eq 'free') {
                        try {
                            if (Test-ManagedInUse $Folder $OwnerSid) { $state = 'held' }
                        } catch {
                            $notes = @('NOTE|the programs could not be read: ' + (Format-Field $_.Exception.Message))
                        }
                    }
                    if ($state -ne 'held' -or [DateTime]::UtcNow -ge $deadline) { break }
                    Start-Sleep -Milliseconds 500
                }
                $lines += "STATE|$state"
                $lines += @(Get-FileLines $files)
                if ($state -eq 'held' -or $Action -eq 'List') {
                    try {
                        $lines += @(Get-HolderLines $Folder $OwnerSid)
                    } catch {
                        $lines += 'NOTE|the programs could not be listed: ' + (Format-Field $_.Exception.Message)
                    }
                } else {
                    $lines += $notes
                }
                $code = @{ free = 10; held = 11; unknown = 12 }[$state]
            }
            'End' {
                # Ending through a handle needs .NET calls, which Constrained Language Mode refuses. It is
                # said here, and nothing is ended another way (by number, say, which is what the handle is for).
                $mode = [string]$ExecutionContext.SessionState.LanguageMode
                if ($mode -ne 'FullLanguage') { throw ('PowerShell is in ' + $mode + ' mode (language mode), which cannot hold a process handle, so nothing was ended') }
                $table = Get-ProcessTable
                $context = New-Context $Folder $table $OwnerSid
                foreach ($pair in (ConvertFrom-Expect $Expect)) {
                    try {
                        $lines += Stop-Expected $pair $context
                    } catch {
                        $lines += 'FAILED|' + $pair.Pid + '|' + (Format-Field $_.Exception.Message)
                    }
                }
                $code = 0
            }
            'Owner' {
                # Long enough not to be a word that is in the command line of whatever is running.
                if ($Marker -notmatch '^[A-Za-z0-9._-]{8,}$') { throw 'no usable -Marker given' }
                $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $Seconds))
                $owner = $null
                while ($true) {
                    $owner = Find-MarkerOwner $Marker
                    if ($owner -or [DateTime]::UtcNow -ge $deadline) { break }
                    Start-Sleep -Milliseconds 250
                }
                if ($owner) {
                    $lines += 'OWNER|' + $owner
                } else {
                    $lines += 'NOTE|no one program carries the marker'
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
