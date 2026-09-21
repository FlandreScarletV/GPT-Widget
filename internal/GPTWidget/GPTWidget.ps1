#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Launch','LaunchPrepared','Prepare','Inspect','Restore','Enable','Paths','RememberPaths')]
    [string]$Mode = 'Launch',
    [string]$StateRoot,
    [string]$InstallRoot,
    [string]$ProfileDirectory,
    [string]$CodexDirectory,
    [switch]$Restart,
    [switch]$UseOfficialData,
    [switch]$VerifySharedCoexistence,
    [switch]$ChooseInstallDirectory,
    [switch]$ChooseDataDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Resolve-Location.ps1')
$packageRoot = Split-Path (Split-Path $PSScriptRoot)
try { $location = Resolve-WidgetLocation -PackageRoot $packageRoot -ExplicitRoot $StateRoot }
catch {
    if(-not $ChooseInstallDirectory){throw}
    # An explicit installation remains available after the cleanup tool removed runtime.
    $recordFile=Join-Path $packageRoot '.widget-location.json'
    $record=if(Test-Path $recordFile){Get-Content $recordFile -Raw|ConvertFrom-Json}else{$null}
    $remainingRoot=if($record.stateRelative){[IO.Path]::GetFullPath([string]$record.stateRelative,$packageRoot)}else{Join-Path $packageRoot '.local-state'}
    if(-not(Test-Path $remainingRoot) -and $record.stateAbsolute -and (Test-Path $record.stateAbsolute)){$remainingRoot=$record.stateAbsolute}
    Write-Host '原副本程序已缺失；安装入口可重新准备程序，保留现有用户数据。'
    $location=[pscustomobject]@{StateRoot=$remainingRoot;Manifest=$null;Source='explicit-reinstall';PackageRoot=$packageRoot}
}
. (Join-Path $PSScriptRoot 'Choose-Directories.ps1')
if ($ChooseInstallDirectory) {
    $oldSettingsPath=Join-Path $location.StateRoot 'environment.json'
    $oldSettings=if(Test-Path $oldSettingsPath){Get-Content $oldSettingsPath -Raw|ConvertFrom-Json}else{$null}
    $selectedRoot=Select-WidgetInstallDirectory -CurrentRoot $location.StateRoot -ProtectedRoots @($env:CODEX_HOME,$oldSettings.profile,$oldSettings.codexHome,$location.Manifest.installRoot,$env:WINDIR,$env:ProgramFiles)
    if(-not $selectedRoot){return}
    if($selectedRoot -ne $location.StateRoot){
        # Relocate program installation only: preserve the existing user environment.
        $previousRoot=$location.StateRoot
        $nextLocation=Resolve-WidgetLocation -PackageRoot $packageRoot -ExplicitRoot $selectedRoot
        if(-not $nextLocation.Manifest){
            $ProfileDirectory=if($oldSettings.profile){$oldSettings.profile}else{Join-Path $previousRoot 'profile'}
            $CodexDirectory=if($oldSettings.codexHome){$oldSettings.codexHome}else{Join-Path $previousRoot 'codex-home'}
            if(-not(Test-Path $ProfileDirectory)){$ProfileDirectory=$null}
            if(-not(Test-Path $CodexDirectory)){$CodexDirectory=$null}
            if($oldSettings.sharedOfficialData){$UseOfficialData=$true}
        }
        $location=$nextLocation
    }
}
if($ChooseDataDirectory){
    $choices=@(Get-WidgetDataCandidates -PackageRoot $packageRoot -StateRoot $location.StateRoot)
    $CodexDirectory=Select-WidgetDataDirectory -Candidates $choices
    if(-not $CodexDirectory){return}
    $UseOfficialData=$true
    @{path=$CodexDirectory;selectedAt=(Get-Date).ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $packageRoot '.official-data-choice.json')
}
$StateRoot = $location.StateRoot
if ($Mode -eq 'Paths') { $location | Select-Object StateRoot,Runtime,Source | ConvertTo-Json; return }
if ($Mode -eq 'LaunchPrepared' -and -not $location.Manifest) { throw '没有找到已准备的副本；未创建任何目录。请指定原 StateRoot 或运行安装入口。' }
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$null = New-Item -ItemType Directory -Force -Path $StateRoot
$manifestPath = Join-Path $StateRoot 'current.json'
$lock = [IO.File]::Open((Join-Path $StateRoot 'operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
function Read-Manifest {
    if (Test-Path -LiteralPath $manifestPath) {
        return Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    return $null
}
function Save-Manifest($value) {
    $temp = $manifestPath + '.tmp'
    $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temp -Encoding utf8
    Move-Item -LiteralPath $temp -Destination $manifestPath -Force
}
function Assert-InState([string]$value) {
    $full = [IO.Path]::GetFullPath($value)
    if (-not $full.StartsWith($StateRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside Inspector state directory: $full"
    }
    return $full
}
function Hash([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-Patcher([string[]]$PatcherArguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.ArgumentList.Add($patcher)
    foreach ($argument in $PatcherArguments) { $info.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::Start($info)
    $outTask = $child.StandardOutput.ReadToEndAsync()
    $errTask = $child.StandardError.ReadToEndAsync()
    $child.WaitForExit()
    if ($child.ExitCode -ne 0) { throw $errTask.GetAwaiter().GetResult() }
    return $outTask.GetAwaiter().GetResult() | ConvertFrom-Json
}
function Assert-Closed([string]$app) {
    $exe = Join-Path $app 'ChatGPT.exe'
    $running = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
    if ($running) { throw '请先关闭副本再执行恢复或更新；官方 Codex 可以保持打开。' }
}
try {
    Save-WidgetLocation $location
    if ($Mode -eq 'RememberPaths') { Write-Output ('已绑定已有副本：'+$StateRoot); return }
    $current = Read-Manifest
    if ($Mode -eq 'Restore') {
        if (-not $current) { throw 'No prepared runtime to restore' }
        $app = Assert-InState $current.runtime
        Assert-Closed $app
        $target = Join-Path $app 'resources\app.asar'
        $backup = Assert-InState $current.backup
        if ((Hash $backup) -ne $current.sourceSha256) { throw 'Original backup hash mismatch' }
        $existing = Hash $target
        if ($existing -notin @($current.patchedSha256, $current.sourceSha256)) { throw 'Unknown runtime changes; refusing restore' }
        $restoreTemp = $target + '.restore'
        Copy-Item -LiteralPath $backup -Destination $restoreTemp
        if ((Hash $restoreTemp) -ne $current.sourceSha256) { throw 'Restore staging verification failed' }
        Move-Item -LiteralPath $restoreTemp -Destination $target -Force
        if ((Hash $target) -ne $current.sourceSha256) { throw 'Restore verification failed' }
        $current.patchDisabled = $true
        Save-Manifest $current
        Write-Output '原文件已恢复并校验；自动补丁已停用。重新启用：-Mode Enable'
        return
    }
    if ($Mode -eq 'Enable') {
        if ($current) { $current.patchDisabled = $false; Save-Manifest $current }
        $Mode = 'Prepare'
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    if (-not $node) {
        $node = @(
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
        ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (-not $node) { throw '未找到 Node.js 22+，请安装后重试。' }
    if ($Mode -ne 'LaunchPrepared') {
    if (-not $InstallRoot) {
        $pkg = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
        if (-not $pkg) { throw '未找到 Codex 安装，请用 -InstallRoot 指定包含 resources/app.asar 的 app 目录。' }
        $InstallRoot = Join-Path $pkg.InstallLocation 'app'
    }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $source = Join-Path $InstallRoot 'resources\app.asar'
    $patcher = Join-Path $PSScriptRoot 'src\patcher.mjs'
    try { $inspection = Invoke-Patcher @('inspect', $source) } catch {
        $compatibilityReason = $_.Exception.Message
        @{ status = '待适配版本'; reason = $compatibilityReason; installRoot = $InstallRoot; time = (Get-Date).ToString('o') } |
            ConvertTo-Json | Set-Content (Join-Path $StateRoot 'last-check.json')
        throw ('特征不兼容，未修改已安装文件。具体原因：' + $compatibilityReason)
    }
    if ($Mode -eq 'Inspect') { $inspection; return }
    $sourceHash = Hash $source
    $toolHash = Hash (Join-Path $PSScriptRoot 'src\status.mjs')
    $patcherHash = (Hash $patcher).Substring(0,8) + (Hash (Join-Path $PSScriptRoot 'src\quit-copy.mjs')).Substring(0,8)
    $runtimeKey = $inspection.version + '-' + $sourceHash.Substring(0,16) + '-' + $toolHash.Substring(0,8) + '-' + $patcherHash
    $runtime = Assert-InState (Join-Path $StateRoot ('runtimes\' + $runtimeKey))
    $target = Join-Path $runtime 'resources\app.asar'
    $disabled = $current -and $current.patchDisabled
    $reusable = $current -and $current.runtime -eq $runtime -and (Test-Path -LiteralPath $target)
    if ($reusable) {
        $expected = if ($disabled) { $current.sourceSha256 } else { $current.patchedSha256 }
        $reusable = (Hash $target) -eq $expected
    }
    if (-not $reusable) {
        if (Test-Path -LiteralPath $runtime) {
            Assert-Closed $runtime
            # Keep interrupted or restored copies as evidence; don't delete or overwrite them.
            $retained = Assert-InState ($runtime + '.retained-' + [guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $runtime -Destination $retained
        }
        $stage = Assert-InState (Join-Path $StateRoot ('stage-' + [guid]::NewGuid().ToString('N')))
        $null = New-Item -ItemType Directory -Path $stage
        & robocopy $InstallRoot $stage /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Runtime copy failed; retained staging directory: $stage" }
        $stagedAsar = Join-Path $stage 'resources\app.asar'
        if ((Hash $source) -ne $sourceHash -or (Hash $stagedAsar) -ne $sourceHash) {
            throw 'Codex changed during copy; retry after its update finishes'
        }
        $candidate = Join-Path $stage 'resources\app.asar.inspector'
        $report = Invoke-Patcher @('build', $stagedAsar, $candidate, (Join-Path $StateRoot 'backups'))
        if (-not $disabled) {
            Move-Item -LiteralPath $candidate -Destination $stagedAsar -Force
            if ((Hash $stagedAsar) -ne $report.patchedSha256) {
                Copy-Item -LiteralPath $report.backup -Destination $stagedAsar -Force
                throw '补丁写入校验失败，已恢复 staging 原文件'
            }
        }
        $null = New-Item -ItemType Directory -Force -Path (Split-Path $runtime)
        Move-Item -LiteralPath $stage -Destination $runtime
        $current = [pscustomobject]@{
            version = $inspection.version; runtime = $runtime; backup = [IO.Path]::GetFullPath($report.backup)
            sourceSha256 = $sourceHash; patchedSha256 = $report.patchedSha256
            patchDisabled = [bool]$disabled; installRoot = $InstallRoot; desktopAcceptance = 'pending'
        }
        Save-Manifest $current
    }
    } else {
        if (-not $current) { throw '没有已准备的工作副本' }
        $runtime = Assert-InState $current.runtime
        $target = Join-Path $runtime 'resources\app.asar'
        $expected = if ($current.patchDisabled) { $current.sourceSha256 } else { $current.patchedSha256 }
        if ((Hash $target) -ne $expected) { throw '工作副本校验失败' }
    }
    Write-Output ("工作副本就绪: " + $runtime)
    if ($Mode -eq 'Prepare') { return }
    $environmentFile = Join-Path $StateRoot 'environment.json'
    $savedEnvironment = if (Test-Path -LiteralPath $environmentFile) { Get-Content -LiteralPath $environmentFile -Raw | ConvertFrom-Json } else { $null }
    if (-not $savedEnvironment -and -not $CodexDirectory) {
        $previousChoice = Join-Path $packageRoot '.official-data-choice.json'
        if (Test-Path -LiteralPath $previousChoice) {
            $CodexDirectory = (Get-Content -Raw -LiteralPath $previousChoice | ConvertFrom-Json).path
            if ($CodexDirectory) { $UseOfficialData = $true }
        }
    }
    $profilePath = if ($ProfileDirectory) { [IO.Path]::GetFullPath($ProfileDirectory) } elseif ($savedEnvironment.profile) { $savedEnvironment.profile } else { Join-Path $StateRoot 'profile' }
    $data = if ($CodexDirectory) { [IO.Path]::GetFullPath($CodexDirectory) } elseif ($savedEnvironment.codexHome) { $savedEnvironment.codexHome } else { Join-Path $StateRoot 'codex-home' }
    $shared = [bool]($UseOfficialData -or $savedEnvironment.sharedOfficialData -or $savedEnvironment.sharedWorkHome)
    if ($savedEnvironment.sharedWorkHome -and -not $CodexDirectory) { $data = $savedEnvironment.sharedWorkHome }
    if ($UseOfficialData) {
        if (-not $CodexDirectory) {
            $choiceFile=Join-Path $packageRoot '.official-data-choice.json'
            if(Test-Path $choiceFile){$CodexDirectory=(Get-Content $choiceFile -Raw|ConvertFrom-Json).path}
        }
        if (-not $CodexDirectory) { throw '尚未明确选择官方工作目录，请运行同步数据入口。不会默认使用 C 盘。' }
        $data=[IO.Path]::GetFullPath($CodexDirectory)
        if (-not (Test-Path -LiteralPath (Join-Path $data 'config.toml'))) { throw '所选官方工作目录不存在，未更换目录。' }
    }
    if ($shared) {
        # Enable everyday coexistence for the version verified on this machine.
        # Keep explicit verification available when adapting a newer version.
        $coexistenceAllowed = $VerifySharedCoexistence -or $current.version -eq '26.915.31945'
        $official = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path -notlike ((Join-Path $StateRoot 'runtimes')+'\*')
        })
        if ($official.Count -and -not $coexistenceAllowed) { throw '此副本版本尚未验证共存。请先退出官方 APP，或完成新版共存验证。' }
        if ($coexistenceAllowed) {
            if ([IO.Path]::GetFullPath($profilePath).TrimEnd('\') -eq [IO.Path]::GetFullPath($data).TrimEnd('\')) { throw '共存验证要求独立的窗口配置目录。' }
            if ([IO.Path]::GetFullPath($profilePath).TrimEnd('\') -ne [IO.Path]::GetFullPath((Join-Path $StateRoot 'profile')).TrimEnd('\')) { throw '共存模式需要使用副本自身的 profile 目录，不能复用官方窗口配置。' }
            Write-Output '共存模式：独立登录，共享本地工作会话。'
        }
        if ($savedEnvironment.sharedOfficialData -and -not $UseOfficialData -and -not $CodexDirectory) { $data = $savedEnvironment.codexHome }
    }
    $otherCopy = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith((Join-Path $StateRoot 'runtimes')+'\',[StringComparison]::OrdinalIgnoreCase) -and
        $_.Path -ne (Join-Path $runtime 'ChatGPT.exe')
    }
    if ($Restart) {
        $owned = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith((Join-Path $StateRoot 'runtimes')+'\',[StringComparison]::OrdinalIgnoreCase)
        })
        foreach ($appProcess in $owned) { Stop-Process -Id $appProcess.Id -ErrorAction SilentlyContinue }
        foreach ($appProcess in $owned) { try { $null=$appProcess.WaitForExit(5000) } catch {} }
    } elseif ($otherCopy) {
        & (Join-Path $PSScriptRoot 'Show-GPTWidget.ps1') -ProcessIds @($otherCopy.Id)
        Write-Output '已显示旧副本。需要切换到已准备的新版时，请运行 Restart Inspector.cmd；重启前请保存未发送内容。'
        return
    }
    $existing = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $runtime 'ChatGPT.exe') })
    if ($existing.Count) {
        & (Join-Path $PSScriptRoot 'Show-GPTWidget.ps1') -ProcessIds $existing.Id
        return
    }
    if (-not (Test-Path (Join-Path $PSScriptRoot '..\codex-model-inspector\server.mjs'))) {
        throw '缺少同级 codex-model-inspector 查询组件；请保留两个输出目录。'
    }
    $workHome = if ($shared) { $data } else { $null }
    if ($workHome) {
        . (Join-Path $PSScriptRoot 'Account-Home.ps1')
        $data = Initialize-WidgetAccountHome -StateRoot $StateRoot -WorkHome $workHome
    }
    if ($savedEnvironment) {
        foreach ($savedPath in @($profilePath,$data)) { if (-not (Test-Path -LiteralPath $savedPath)) { throw ('原用户环境目录不存在，停止启动而不是创建空环境：'+$savedPath) } }
    }
    $null = New-Item -ItemType Directory -Force -Path $profilePath,$data
    if (Test-Path -LiteralPath $environmentFile) { Copy-Item -LiteralPath $environmentFile -Destination ($environmentFile+'.previous') -Force }
    @{profile=$profilePath;codexHome=$data;sharedOfficialData=$false;sharedWorkHome=$workHome;accountIsolation="file-v1"} | ConvertTo-Json | Set-Content -LiteralPath ($environmentFile+'.tmp')
    Move-Item -LiteralPath ($environmentFile+'.tmp') -Destination $environmentFile -Force
    $appearanceSourceRecord = Join-Path $StateRoot 'appearance-source.txt'
    $appearanceSource = if ($workHome) { Join-Path $workHome 'config.toml' } elseif (Test-Path -LiteralPath $appearanceSourceRecord) { (Get-Content -LiteralPath $appearanceSourceRecord -Raw).Trim() }
        elseif ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'config.toml' }
        else { Join-Path $env:USERPROFILE '.codex\config.toml' }
    & $node (Join-Path $PSScriptRoot 'src\sync-appearance.mjs') $appearanceSource (Join-Path $data 'config.toml')
    if ($LASTEXITCODE -ne 0) { throw '外观同步失败，已停止启动；原配置备份保留。' }
    if (Test-Path -LiteralPath $appearanceSource) { Set-Content -LiteralPath $appearanceSourceRecord -Value $appearanceSource }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $runtime 'ChatGPT.exe'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
    $start.Environment['CODEX_ELECTRON_USER_DATA_PATH'] = $profilePath
    $start.Environment['CODEX_HOME'] = $data
    if ($workHome) { $start.Environment['CODEX_SQLITE_HOME'] = $workHome }
    else { $null = $start.Environment.Remove('CODEX_SQLITE_HOME') }
    # A copied executable has no MSIX identity. Use the supported explicit core
    # path so bootstrap selects the bundled core rather than package activation.
    if ([string]::IsNullOrWhiteSpace($start.Environment['CODEX_CLI_PATH'])) {
        $bundledCore = Join-Path $runtime 'resources\codex.exe'
        if (-not (Test-Path -LiteralPath $bundledCore -PathType Leaf)) { throw '副本缺少 resources\codex.exe，无法使用独立运行模式。请重新安装副本。' }
        $start.Environment['CODEX_CLI_PATH'] = $bundledCore
    }
    # Keep the app's normal close-to-tray and tray-menu quit behavior.
    $start.Environment['CMI_EXIT_ON_CLOSE'] = '0'
    $start.ArgumentList.Add('--user-data-dir=' + $profilePath)
    $process = [Diagnostics.Process]::Start($start)
    if (-not $current.patchDisabled) {
        if (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'CodexModelInspector\ipapi-is.key'))) {
            Write-Output '未配置 IP 质量服务，跳过完整风险检测；IP 地区查询仍可用。'
        }
        $worker = [Diagnostics.ProcessStartInfo]::new()
        $worker.FileName = $node
        $worker.UseShellExecute = $false
        $worker.CreateNoWindow = $true
        $worker.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $worker.ArgumentList.Add((Join-Path $PSScriptRoot 'src\exit-worker.mjs'))
        $worker.ArgumentList.Add((Join-Path $runtime 'resources\app.asar.unpacked\webview\inspector-state.json'))
        $worker.ArgumentList.Add([string]$process.Id)
        $worker.ArgumentList.Add((Join-Path $StateRoot 'logs'))
        $null = [Diagnostics.Process]::Start($worker)
    }
    Write-Output ("已启动副本 PID " + $process.Id + '。首次使用请在副本内正常登录。')
    if ($process.WaitForExit(5000) -and $process.ExitCode -ne 0) {
        Assert-Closed $runtime
        if ((Hash $current.backup) -ne $current.sourceSha256) { throw '启动失败，且备份校验失败，已停止自动恢复。' }
        Copy-Item -LiteralPath $current.backup -Destination ($target + '.restore')
        if ((Hash ($target + '.restore')) -ne $current.sourceSha256) { throw '恢复副本校验失败' }
        Move-Item -LiteralPath ($target + '.restore') -Destination $target -Force
        $current.patchDisabled = $true
        Save-Manifest $current
        throw '副本启动异常，已恢复官方原资源并停用补丁。'
    }
    $visibleProcesses = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $start.FileName })
    if ($visibleProcesses.Count) {
        try { & (Join-Path $PSScriptRoot 'Show-GPTWidget.ps1') -ProcessIds $visibleProcesses.Id }
        catch { Write-Output '副本仍在加载。再次点击打开可唤出窗口；无窗口时可使用 Restart Inspector.cmd 恢复。' }
    }
} finally { $lock.Dispose() }
