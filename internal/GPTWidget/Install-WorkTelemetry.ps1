# Install a prepared, hash-checked patch only after this runtime is closed.
param([Parameter(Mandatory)][string]$StateRoot,[Parameter(Mandatory)][string]$StageDirectory)
$ErrorActionPreference='Stop'
$manifestPath=Join-Path $StateRoot 'current.json'
$current=Get-Content -Raw -LiteralPath $manifestPath|ConvertFrom-Json
$report=Get-Content -Raw -LiteralPath (Join-Path $StageDirectory 'report.json')|ConvertFrom-Json
$runtime=[IO.Path]::GetFullPath($current.runtime)
if($runtime -ne [IO.Path]::GetFullPath($report.runtime)){throw '暂存补丁不属于当前副本。'}
$exe=Join-Path $runtime 'ChatGPT.exe'
if(@(Get-Process ChatGPT -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq $exe}).Count){throw '请先从副本托盘退出副本，官方 APP 可以保持运行。'}
$target=Join-Path $runtime 'resources/app.asar'
$candidate=Join-Path $StageDirectory 'app.asar'
if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $report.sourceSha256){throw '当前副本已变化，请重新构建补丁。'}
if((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ne $report.patchedSha256){throw '暂存补丁校验失败。'}
$backup=Join-Path $StateRoot ('backups/work-telemetry-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $backup
Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'app.asar')
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $backup 'current.json')
$runtimeRecord=Join-Path $runtime 'widget-runtime.json'
$hadRecord=Test-Path -LiteralPath $runtimeRecord
if($hadRecord){Copy-Item -LiteralPath $runtimeRecord -Destination (Join-Path $backup 'widget-runtime.json')}
try{
 Copy-Item -LiteralPath $candidate -Destination ($target+'.work-stage')
 if((Get-FileHash -LiteralPath ($target+'.work-stage') -Algorithm SHA256).Hash -ne $report.patchedSha256){throw '复制后校验失败。'}
 Move-Item -LiteralPath ($target+'.work-stage') -Destination $target -Force
 $current.patchedSha256=$report.patchedSha256
 $current|Add-Member -Force NoteProperty workTelemetry $true
 $current|Add-Member -Force NoteProperty workTelemetryBackup $backup
 $current.desktopAcceptance='pending'
 $json=$current|ConvertTo-Json -Depth 12
 foreach($file in @($manifestPath,$runtimeRecord)){Set-Content -LiteralPath ($file+'.tmp') -Value $json -Encoding utf8;Move-Item -LiteralPath ($file+'.tmp') -Destination $file -Force}
 Write-Output '模型遥测补丁已安装；下次通过原启动副本入口启动后生效。'
}catch{
 Copy-Item -LiteralPath (Join-Path $backup 'app.asar') -Destination $target -Force
 Copy-Item -LiteralPath (Join-Path $backup 'current.json') -Destination $manifestPath -Force
 if($hadRecord){Copy-Item -LiteralPath (Join-Path $backup 'widget-runtime.json') -Destination $runtimeRecord -Force}
 throw
}
