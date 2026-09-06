# Uninstall script for GTA Connected (client + NinoGames-hosted server).
# It removes ONLY GTA Connected: the client install folder, its shortcuts and
# registry entries, and the NinoGames gtac-server package.
# Your GTA IV game files are left completely untouched.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall-gtac.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall-gtac.ps1 -Force

param(
    [switch]$Force,
    [switch]$SkipElevate
)

$ErrorActionPreference = 'Stop'

function Get-Elevated {
    $wid = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $pr  = New-Object System.Security.Principal.WindowsPrincipal($wid)
    return $pr.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

$clientDirs = @(
    Join-Path $env:LOCALAPPDATA "Jack's Mini Network\Grand Theft Auto Connected"
    Join-Path $env:APPDATA      "Jack's Mini Network\Grand Theft Auto Connected"
)
$serverDir  = Join-Path $env:APPDATA 'NinoGames\gtac-server'

# Also catch client installs placed somewhere else (user picked a custom folder).
foreach ($root in @($env:LOCALAPPDATA, $env:APPDATA)) {
    if (Test-Path $root) {
        foreach ($d in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue) {
            $inner = Join-Path $d.FullName 'Grand Theft Auto Connected'
            if (Test-Path $inner) { $clientDirs += $inner }
        }
    }
}
$clientDirs = $clientDirs | Select-Object -Unique

# GTAC client uninstall entries in the registry.
$uninstallKeys = @()
foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                    'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (-not (Test-Path $hive)) { continue }
    foreach ($key in Get-ChildItem $hive -ErrorAction SilentlyContinue) {
        $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
        if ($props.DisplayName -match 'GTA Connected|GTAC' -or $props.PSChildName -match 'gtac') {
            $uninstallKeys += $key.PSPath
        }
    }
}

$regEntries = @()
if (Test-Path 'HKCU:\Software\GTA Connected') { $regEntries += 'HKCU:\Software\GTA Connected' }
if (Test-Path 'HKCU:\Software\Classes\gtac')   { $regEntries += 'HKCU:\Software\Classes\gtac' }

$needAdmin = $false
foreach ($d in $clientDirs) {
    if ($d -and $d.StartsWith($env:ProgramFiles, [System.StringComparison]::OrdinalIgnoreCase)) { $needAdmin = $true }
}
if ($uninstallKeys | Where-Object { $_ -like 'HKLM:*' }) { $needAdmin = $true }

if ($needAdmin -and -not (Get-Elevated) -and -not $SkipElevate) {
    $relaunchArgs = @('-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-SkipElevate')
    if ($Force) { $relaunchArgs += '-Force' }
    Write-Host 'Administrator rights are required. Restarting elevated…'
    Start-Process powershell -Verb RunAs -ArgumentList $relaunchArgs
    exit 0
}

$toRemove = @()
foreach ($d in $clientDirs) { if ($d -and (Test-Path $d)) { $toRemove += $d } }
if (Test-Path $serverDir) { $toRemove += $serverDir }

Write-Host ''
Write-Host '=== GTA Connected Uninstall ===' -ForegroundColor Cyan
Write-Host ''
if ($toRemove.Count -eq 0 -and $uninstallKeys.Count -eq 0 -and $regEntries.Count -eq 0) {
    $anyShortcut = Get-ChildItem ([Environment]::GetFolderPath('Desktop')), ([Environment]::GetFolderPath('StartMenu')), ([Environment]::GetFolderPath('Programs')) -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'GTA Connected|GTAC' }
    if (-not $anyShortcut) {
        Write-Host 'Nothing to do - GTA Connected is not installed.' -ForegroundColor Green
        exit 0
    }
}

Write-Host 'The following will be removed:'
foreach ($p in $toRemove)  { Write-Host "  [DIR ] $p" }
foreach ($p in $uninstallKeys) { Write-Host "  [REGV] $p" }
foreach ($p in $regEntries) { Write-Host "  [REGV] $p" }
Write-Host '  [LNKS] GTA Connected / GTAC shortcuts (desktop & start menu)'
Write-Host ''
Write-Host 'Your GTA IV game files are NOT touched.' -ForegroundColor Yellow
if (-not $Force) {
    $ans = Read-Host "Type 'uninstall' to confirm"
    if ($ans -ne 'uninstall') { Write-Host 'Cancelled.'; exit 1 }
}

Write-Host ''
Write-Host 'Stopping running GTA Connected processes…'
$stopRoots = @()
foreach ($r in @($clientDirs + $serverDir)) {
    if ($r) { $stopRoots += $r.TrimEnd('\', '/') }
}
foreach ($procName in @('Grand Theft Auto Connected', 'GTACServer', 'Multi Theft Auto Server', 'mta-server')) {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $exe = $_.ExecutablePath
    if ($exe) {
        foreach ($root in $stopRoots) {
            if ($exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                break
            }
        }
    }
}
Start-Sleep -Milliseconds 500

$failed = @()
foreach ($d in $toRemove) {
    Write-Host "Removing $d"
    try    { Remove-Item $d -Recurse -Force -ErrorAction Stop }
    catch  { $failed += $d }
}

foreach ($p in @($uninstallKeys + $regEntries)) {
    Write-Host "Removing registry key $p"
    try    { Remove-Item $p -Recurse -Force -ErrorAction Stop }
    catch  { $failed += $p }
}

Write-Host 'Removing GTA Connected / GTAC shortcuts…'
foreach ($lnk in Get-ChildItem ([Environment]::GetFolderPath('Desktop')), ([Environment]::GetFolderPath('StartMenu')), ([Environment]::GetFolderPath('Programs')) -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue) {
    if ($lnk.Name -match 'GTA Connected|GTAC') {
        Remove-Item $lnk.FullName -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host 'Some items could not be removed (they may be in use or need admin):' -ForegroundColor Red
    foreach ($f in $failed) { Write-Host "  $f" }
    exit 2
}
Write-Host 'GTA Connected has been uninstalled. Your GTA IV install was left alone.' -ForegroundColor Green