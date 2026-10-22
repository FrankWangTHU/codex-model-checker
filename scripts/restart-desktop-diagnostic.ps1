[CmdletBinding()]
param(
    [ValidateRange(5,120)][int]$DelaySeconds = 25,
    [ValidatePattern('^CodexModelChecker-Diagnostic-[a-f0-9]{32}$')][string]$ScheduledTaskName,
    [string]$ReportRoot,
    [ValidateSet('Diagnostic','Normal')][string]$Mode = 'Diagnostic'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReportRoot) { $ReportRoot = Join-Path $projectRoot 'test-results\appserver-trace' }
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$statusFile = Join-Path $reportRoot 'restart-status.json'
function Write-RestartStatus([string]$Phase, [hashtable]$Extra = @{}) {
    $record = @{ phase = $Phase; updatedAt = [DateTimeOffset]::Now.ToString('o') }
    foreach ($key in $Extra.Keys) { $record[$key] = $Extra[$key] }
    $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusFile -Encoding utf8
}
function Stop-ExactProcess($Snapshot) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Snapshot.ProcessId) -ErrorAction SilentlyContinue
    if ($current -and $current.ExecutablePath -eq $Snapshot.ExecutablePath -and $current.CreationDate -eq $Snapshot.CreationDate) {
        Stop-Process -Id $current.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
try {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw '未找到 Codex 安装包。' }
    $appFile = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (-not (Test-Path -LiteralPath $appFile)) { throw '未找到桌面入口。' }
    Write-RestartStatus 'scheduled' @{ delaySeconds = $DelaySeconds; appPath = $appFile }
    Start-Sleep -Seconds $DelaySeconds
    $allTasks = @(Get-CimInstance Win32_Process)
    $appTasks = @($allTasks | Where-Object { $_.ExecutablePath -eq $appFile })
    $appIds = @($appTasks | ForEach-Object ProcessId)
    $coreRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')) + [System.IO.Path]::DirectorySeparatorChar
    $resourceRoot = [System.IO.Path]::GetFullPath((Join-Path $package.InstallLocation 'app\resources')) + [System.IO.Path]::DirectorySeparatorChar
    $ownedBackends = @($allTasks | Where-Object {
        if ($_.Name -ine 'codex.exe' -or $_.ParentProcessId -notin $appIds -or -not $_.ExecutablePath) { return $false }
        $path = [System.IO.Path]::GetFullPath($_.ExecutablePath)
        return $path.StartsWith($coreRoot, [StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($resourceRoot, [StringComparison]::OrdinalIgnoreCase)
    })
    Write-RestartStatus 'closing' @{ desktopProcessIds = $appIds; backendProcessIds = @($ownedBackends | ForEach-Object ProcessId) }
    foreach ($task in $appTasks | Where-Object { $_.ParentProcessId -notin $appIds }) {
        $process = Get-Process -Id $task.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    Start-Sleep -Seconds 5
    foreach ($task in $appTasks) { Stop-ExactProcess $task }
    foreach ($task in $ownedBackends) { Stop-ExactProcess $task }
    Start-Sleep -Seconds 2
    Write-RestartStatus 'starting'
    & (Join-Path $PSScriptRoot 'start-desktop-diagnostic.ps1') -ReportRoot $ReportRoot -Mode $Mode
    Write-RestartStatus 'started' @{ sessionFile = (Join-Path $reportRoot 'desktop-session.json'); nextStep = '回到原对话发送“已重开”，再只读核验真实桌面请求。' }
} catch {
    Write-RestartStatus 'failed' @{ error = $_.Exception.Message; recovery = '可从正常快捷方式打开 Codex；配置和全局环境未修改。' }
} finally {
    if ($ScheduledTaskName) {
        Unregister-ScheduledTask -TaskName $ScheduledTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}
