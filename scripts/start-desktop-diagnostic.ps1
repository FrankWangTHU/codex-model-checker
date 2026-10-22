[CmdletBinding()]
param([string]$ReportRoot, [ValidateSet('Diagnostic','Normal')][string]$Mode = 'Diagnostic')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReportRoot) { $ReportRoot = Join-Path $projectRoot 'test-results\appserver-trace' }
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw '未找到已安装的 Codex 桌面程序。' }
$appFile = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $appFile)) { throw '未找到桌面程序入口。' }
$running = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $appFile }
if ($running) { throw '请先保存工作并完全退出 Codex，再运行此脚本。脚本不会自动结束当前对话。' }
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$codexConfig = Join-Path $env:USERPROFILE '.codex\config.toml'
$hash = if (Test-Path -LiteralPath $codexConfig) { (Get-FileHash -LiteralPath $codexConfig -Algorithm SHA256).Hash } else { $null }
$logRoot = Join-Path $env:LOCALAPPDATA ('Packages\' + $package.PackageFamilyName + '\LocalCache\Local\Codex\Logs')
$logRoots = @($logRoot, (Join-Path $env:LOCALAPPDATA 'Codex\Logs'))
$baseline = @(foreach ($root in $logRoots) { if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.log' | ForEach-Object FullName } })
$session = @{ startedAt = [DateTimeOffset]::Now.ToString('o'); appPath = $appFile; configHash = $hash; logRoot = $logRoot; baselineLogFiles = $baseline; diagnosticMode = 'temporary-child-environment'; restore = '完全退出本次 Codex，再从正常快捷方式打开；无需修改配置。' }
if ($Mode -eq 'Diagnostic') { $session | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $reportRoot 'desktop-session.json') -Encoding utf8 }
Write-Host '仅本次启动开启模型响应诊断；Codex 自身的日志可能包含对话正文。'
Write-Host '不会改模型、请求地址、系统代理、证书或用户环境变量。'
$start = [System.Diagnostics.ProcessStartInfo]::new($appFile)
$start.UseShellExecute = $false
# Do not pass this coding task's internal pipe, sandbox, CLI override, or request
# identifiers into a fresh desktop. Preserve persistent user/machine settings and
# documented location/auth/network overrides only.
$publicOverrides = @('CODEX_HOME','CODEX_SQLITE_HOME','CODEX_CA_CERTIFICATE','CODEX_API_KEY','CODEX_ACCESS_TOKEN')
foreach ($name in @($start.EnvironmentVariables.Keys | Where-Object { $_ -like 'CODEX_*' })) {
    $persistent = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($null -eq $persistent) { $persistent = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    if ($null -ne $persistent) { $start.EnvironmentVariables[$name] = $persistent }
    elseif ($name -notin $publicOverrides) { $start.EnvironmentVariables.Remove($name) }
}
foreach ($name in @('RUST_LOG','CODEX_MAX_LOG_LEVEL')) {
    $persistent = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($null -eq $persistent) { $persistent = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    if ($null -ne $persistent) { $start.EnvironmentVariables[$name] = $persistent } else { $start.EnvironmentVariables.Remove($name) }
}
if ($Mode -eq 'Diagnostic') {
    $start.EnvironmentVariables['RUST_LOG'] = 'error,tungstenite::protocol=trace,tungstenite::protocol::frame=off,codex_api::sse::responses=trace'
    $start.EnvironmentVariables['CODEX_MAX_LOG_LEVEL'] = 'debug'
}
$process = [System.Diagnostics.Process]::Start($start)
Write-Host ('已启动诊断桌面进程，PID：' + $process.Id)
Write-Host '请在原对话发送一句短消息，然后运行：node scripts/read-desktop-models.mjs'
