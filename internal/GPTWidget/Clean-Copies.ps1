#requires -Version 5.1
[CmdletBinding()]
param([string[]]$StateRoot,[switch]$Interactive,[switch]$Apply,[string[]]$TargetDirectory)
$ErrorActionPreference='Stop'
function Full([string]$p){if(-not [IO.Path]::IsPathRooted($p)){throw "需要绝对路径：$p"};[IO.Path]::GetFullPath($p).TrimEnd('\')}
function Within([string]$p,[string]$parent){$p.Equals($parent,[StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase)}
function ReadJson([string]$p){if(Test-Path -LiteralPath $p){Get-Content -LiteralPath $p -Raw | ConvertFrom-Json}}
function NoLinks([string]$p,[switch]$Tree){
    $item=Get-Item -LiteralPath $p -Force
    for($a=$item;$a;$a=$a.Parent){if($a.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "拒绝处理链接或重定向目录：$($a.FullName)"}}
    if($Tree){$queue=New-Object 'System.Collections.Generic.Queue[string]';$queue.Enqueue($p);while($queue.Count){foreach($child in (Get-ChildItem -LiteralPath $queue.Dequeue() -Force)){if($child.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "目录内存在链接，保留整个副本：$($child.FullName)"};if($child.PSIsContainer){$queue.Enqueue($child.FullName)}}}}
}
$roots=@()
if($StateRoot){$roots=@($StateRoot)}else{
    foreach($brand in @('CodexWidget','CodexModelInspector')){
        $base=Join-Path $env:LOCALAPPDATA $brand
        $record=Join-Path $base 'runtime-state.txt'
        if(Test-Path -LiteralPath $record){$roots+=(Get-Content -LiteralPath $record -Raw).Trim()}
        $roots+=Join-Path $base 'runtime-state'
    }
    $packageRoot=Split-Path (Split-Path $PSScriptRoot)
    $roots+=Join-Path $packageRoot '.local-state'
    $locationFile=Join-Path $packageRoot '.widget-location.json'
    if(Test-Path -LiteralPath $locationFile){
        $location=ReadJson $locationFile
        if($location.stateRelative){$roots+= [IO.Path]::GetFullPath((Join-Path $packageRoot $location.stateRelative))}
        if($location.stateAbsolute){$roots+=$location.stateAbsolute}
    }
    $roots+=Join-Path $PSScriptRoot '.local-state'
    $roots+=Join-Path (Split-Path $PSScriptRoot) '.local-state'
    # Discover the development workspace relative to this package, never a user name.
    $outputs=Split-Path (Split-Path (Split-Path $PSScriptRoot))
    $roots+=Join-Path (Split-Path $outputs) 'work\launcher-test'
    foreach($package in (Get-ChildItem -LiteralPath $outputs -Directory -Filter 'Inspector-Patch-*' -ErrorAction SilentlyContinue)){
        $roots+=Join-Path $package.FullName 'internal\CodexModelInspector\.local-state'
    }
}
$roots=@($roots|Where-Object {$_ -and (Test-Path -LiteralPath $_ -PathType Container)}|ForEach-Object {Full $_}|Sort-Object -Unique)
$candidates=@()
foreach($root in $roots){
    NoLinks $root
    $manifest=ReadJson (Join-Path $root 'current.json')
    $environment=ReadJson (Join-Path $root 'environment.json')
    $protected=@($env:CODEX_HOME,[Environment]::GetEnvironmentVariable('CODEX_HOME','User'),[Environment]::GetEnvironmentVariable('CODEX_HOME','Machine'),$environment.profile,$environment.codexHome,$manifest.installRoot)|Where-Object {$_}|ForEach-Object {Full $_}
    $dirs=@()
    $runtimeParent=Join-Path $root 'runtimes'
    if(Test-Path -LiteralPath $runtimeParent){NoLinks $runtimeParent;$dirs+=Get-ChildItem -LiteralPath $runtimeParent -Directory -Force}
    $dirs+=Get-ChildItem -LiteralPath $root -Directory -Filter 'stage-*' -Force
    foreach($dir in $dirs){
        $target=Full $dir.FullName
        if($dir.Name -notmatch '^(\d+\.\d+\.\d+-[a-f0-9]{16}-.+|stage-[a-f0-9]{32})$'){continue}
        if(-not (Within $target $root) -or $target -eq $root){throw '目录边界不正确'}
        if(-not(Test-Path -LiteralPath (Join-Path $target 'ChatGPT.exe')) -or -not(Test-Path -LiteralPath (Join-Path $target 'resources\app.asar'))){continue}
        $blocked=@($protected|Where-Object {(Within $_ $target) -or (Within $target $_)}).Count -gt 0
        if($blocked){Write-Warning "包含或位于配置/官方目录内，保留：$target";continue}
        NoLinks $target
        $candidates+=[pscustomobject]@{Root=$root;Path=$target;Current=($manifest.runtime -eq $target)}
    }
}
if(-not $candidates.Count){Write-Output '未找到符合的副本程序目录。没有删除任何文件。';return}
for($i=0;$i -lt $candidates.Count;$i++){Write-Output ('[{0}] {1}{2}' -f ($i+1),$candidates[$i].Path,$(if($candidates[$i].Current){'  [当前副本]'}else{''}))}
Write-Output '仅删除上列选中的程序目录。'
if($Interactive){
    $answer=Read-Host '输入要清理的编号（逗号分隔）；直接回车则取消。'
    if(-not $answer){return}
    if($answer -notmatch '^\s*\d+(\s*,\s*\d+)*\s*$'){throw '编号格式不正确，未删除'}
    $indices=@($answer.Split(',')|ForEach-Object {[int]$_.Trim()})
    foreach($index in $indices){if($index -lt 1 -or $index -gt $candidates.Count){throw '编号超出范围，未删除'}}
    $TargetDirectory=@($indices|ForEach-Object {$candidates[$_-1].Path})
    if((Read-Host '请先从托盘退出副本。确认清理输入 DELETE，其余取消') -cne 'DELETE'){return}
    $Apply=$true
}
if(-not $Apply){Write-Output '预览结束，没有删除。双击“清理副本.cmd”可按编号选择。';return}
if(-not $TargetDirectory){throw '-Apply 必须同时指定 -TargetDirectory，未删除'}
$selected=@()
foreach($target in $TargetDirectory){$absolute=Full $target;$match=@($candidates|Where-Object {$_.Path -eq $absolute});if($match.Count -ne 1){throw "目标不在本次候选清单：$absolute"};$selected+=$match[0]}
$locks=@()
try{
    foreach($root in @($selected.Root|Sort-Object -Unique)){$locks+=[IO.File]::Open((Join-Path $root 'operation.lock'),'OpenOrCreate','ReadWrite','None')}
    $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
    if(@($processes|Where-Object {$_.Name -eq 'ChatGPT.exe' -and -not $_.ExecutablePath}).Count){throw '有无法识别路径的 APP 进程，不能安全检查；未清理'}
    # Preflight every selected tree before deleting any of them.
    foreach($entry in $selected){
        NoLinks $entry.Path -Tree
        $running=@($processes|Where-Object {($_.ExecutablePath -and (Within $_.ExecutablePath $entry.Path)) -or ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($entry.Path,[StringComparison]::OrdinalIgnoreCase) -ge 0)})
        if($running.Count){throw "副本或后台正在使用此目录，请退出后重试：$($entry.Path)"}
    }
    foreach($entry in $selected){
        $manifestPath=Join-Path $entry.Root 'current.json'
        $m=ReadJson $manifestPath
        $isCurrent=$m.runtime -eq $entry.Path
        if($isCurrent){Copy-Item -LiteralPath $manifestPath -Destination ($manifestPath+'.cleanup-backup-'+[guid]::NewGuid().ToString('N'))}
        # Absolute boundaries and link-free traversal were checked above.
        Remove-Item -LiteralPath $entry.Path -Recurse -Force
        if(Test-Path -LiteralPath $entry.Path){throw "清理未完成：$($entry.Path)"}
        if($isCurrent){Remove-Item -LiteralPath $manifestPath}
        Write-Output ('已清理：'+$entry.Path)
    }
    Write-Output '完成。若删除了当前副本，需重新准备程序；本脚本不会启动 APP 或创建新副本。'
}finally{foreach($lock in $locks){$lock.Dispose()}}

