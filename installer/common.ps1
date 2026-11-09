# Helpers shared by stage.ps1 and build-installers.ps1 (dot-sourced, not run).

# The PE machine field of an executable: 0x8664 is x64, 0xAA64 is arm64.
function Get-PeMachine([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Path).Path)
    [BitConverter]::ToUInt16($bytes, [BitConverter]::ToInt32($bytes, 0x3C) + 4)
}

# Fails unless the executable is built for the architecture asked for, so an x64
# program can never end up in an arm64 package or the other way round.
function Assert-PeMachine([string]$Path, [string]$Arch) {
    $want = if ($Arch -eq "arm64") { 0xAA64 } else { 0x8664 }
    $got = Get-PeMachine $Path
    if ($got -ne $want) {
        throw ("{0} is not an {1} executable (PE machine 0x{2:X4})" -f $Path, $Arch, $got)
    }
}

# Fails unless the shell's own version resource matches the version being
# packaged. A pre-release suffix is ignored (1.2.3-rc1 is 1.2.3 in the resource),
# so this catches a shell built before the version was bumped.
function Assert-ShellVersion([string]$Path, [string]$Version) {
    $core = $Version -replace '-.*$', ''
    $info = (Get-Item $Path).VersionInfo
    $got = "{0}.{1}.{2}" -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
    if ($got -ne $core) {
        throw "$Path says it is version $got but the packages are for $Version. Rebuild the shell (npx tauri build --no-bundle in desktop-tauri/) after the version change."
    }
}
