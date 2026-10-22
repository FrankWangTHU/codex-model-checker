[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ReportRoot, [ValidateSet('Diagnostic','Normal')][string]$Mode = 'Diagnostic')
$ErrorActionPreference = 'Stop'
$taskName = 'CodexModelChecker-Diagnostic-' + [guid]::NewGuid().ToString('N')
$helper = Join-Path $PSScriptRoot 'restart-desktop-diagnostic.ps1'
if ($ReportRoot.Contains('"') -or $helper.Contains('"')) { throw 'Invalid script path.' }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $helper + '" -DelaySeconds 5 -ScheduledTaskName ' + $taskName + ' -ReportRoot "' + $ReportRoot + '" -Mode ' + $Mode
$action = New-ScheduledTaskAction -Execute $powershell -Argument $taskArgs -WorkingDirectory $ReportRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(20)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'One-time user-requested Codex diagnostic restart. Self-removes after execution.' | Out-Null
Write-Output 'Restart scheduled.'
