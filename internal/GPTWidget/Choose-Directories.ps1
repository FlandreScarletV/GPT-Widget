#requires -Version 7.0
function Get-WidgetDataCandidates {
    param([string]$PackageRoot,[string]$StateRoot,[object[]]$Hints)
    $hintsList=@($Hints)
    if(-not $PSBoundParameters.ContainsKey('Hints')){
        foreach($scope in @('Process','User','Machine')){$p=[Environment]::GetEnvironmentVariable('CODEX_HOME',$scope);if($p){$hintsList+=@{Path=$p;Source="CODEX_HOME ($scope)"}}}
        $choice=Join-Path $PackageRoot '.official-data-choice.json'
        if(Test-Path -LiteralPath $choice){$j=Get-Content $choice -Raw|ConvertFrom-Json;$hintsList+=@{Path=$j.path;Source='上次明确选择'}}
        $states=@($StateRoot)
        foreach($brand in @('CodexWidget','CodexModelInspector')){
            $record=Join-Path $env:LOCALAPPDATA ($brand+'/runtime-state.txt')
            if(Test-Path $record){$states+=(Get-Content $record -Raw).Trim()}
        }
        foreach($state in @($states|Where-Object {$_}|Sort-Object -Unique)){
            $e=Join-Path $state 'environment.json';if(Test-Path $e){$j=Get-Content $e -Raw|ConvertFrom-Json;if($j.sharedOfficialData){$hintsList+=@{Path=$j.codexHome;Source='已保存的共享工作目录'}}}
            $a=Join-Path $state 'appearance-source.txt';if(Test-Path $a){$hintsList+=@{Path=(Split-Path ((Get-Content $a -Raw).Trim()));Source='历史主题来源（待确认）'}}
        }
        $hintsList+=@{Path=(Join-Path $env:USERPROFILE '.codex');Source='默认位置候选（非自动选定）'}
    }
    $result=@{}
    foreach($hint in $hintsList){
        if(-not $hint.Path -or -not [IO.Path]::IsPathRooted($hint.Path)){continue}
        $p=[IO.Path]::GetFullPath([string]$hint.Path).TrimEnd('\','/')
        if(-not(Test-Path -LiteralPath (Join-Path $p 'config.toml') -PathType Leaf)){continue}
        if($result.ContainsKey($p)){$result[$p].Source+=' / '+$hint.Source;continue}
        # Metadata only: do not open conversations, databases, or credentials.
        $activity=@(Get-ChildItem -LiteralPath $p -File -ErrorAction SilentlyContinue|Where-Object {$_.Name -match '^state_\d+\.sqlite(-wal)?$|^session_index\.jsonl$'}|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1)
        $result[$p]=[pscustomobject]@{Path=$p;Source=[string]$hint.Source;ActivityUtc=$(if($activity.Count){$activity[0].LastWriteTimeUtc}else{[datetime]::MinValue});Evidence=$(if($activity.Count){$activity[0].Name}else{'无工作活动文件'})}
    }
    @($result.Values|Sort-Object ActivityUtc -Descending)
}
function Select-WidgetDataDirectory {
    param([object[]]$Candidates)
    Write-Host '选择要共用的 Codex 数据目录（不是复制文件）。'
    for($i=0;$i -lt $Candidates.Count;$i++){
        $c=$Candidates[$i];$time=if($c.ActivityUtc -eq [datetime]::MinValue){'未知'}else{$c.ActivityUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')}
        Write-Host ("[{0}] {1}`n    来源：{2}；最近工作文件更新：{3}" -f ($i+1),$c.Path,$c.Source,$time)
    }
    Write-Host '按最近工作文件更新时间排序，可直接输入未列出的绝对路径。'
    $answer=(Read-Host '输入编号或完整路径；直接回车取消').Trim().Trim('"')
    if(-not $answer){return $null}
    if($answer -match '^\d+$'){$i=[int]$answer-1;if($i -lt 0 -or $i -ge $Candidates.Count){throw '编号无效'};$answer=$Candidates[$i].Path}
    if(-not [IO.Path]::IsPathRooted($answer)){throw '请输入绝对路径'}
    $p=[IO.Path]::GetFullPath($answer)
    if(-not(Test-Path -LiteralPath (Join-Path $p 'config.toml') -PathType Leaf)){throw '所选目录没有 config.toml，未更改设置'}
    Write-Host ('将共用：'+$p)
    return $p
}
function Select-WidgetInstallDirectory {
    param([string]$CurrentRoot,[string[]]$ProtectedRoots)
    Write-Host ('现有副本目录：'+$CurrentRoot)
    $answer=(Read-Host "输入新的副本安装目录。回车复用现有目录。输入 Q 则取消").Trim().Trim('"')
    if($answer -ieq 'Q'){return $null};if(-not $answer){$answer=$CurrentRoot}
    if(-not [IO.Path]::IsPathRooted($answer)){throw '安装目录必须为绝对路径'}
    $target=[IO.Path]::GetFullPath($answer).TrimEnd('\','/')
    if($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\','/')){throw '请选择专用文件夹，不能直接使用盘符根目录'}
    foreach($p in $ProtectedRoots){if(-not $p){continue};$p=[IO.Path]::GetFullPath($p).TrimEnd('\','/');if($target -eq $p -or $target.StartsWith($p+'\',[StringComparison]::OrdinalIgnoreCase)){throw '不能将副本安装在工作数据、用户配置或官方程序目录内'}}
    if((Test-Path $target) -and -not(Test-Path (Join-Path $target 'current.json')) -and @(Get-ChildItem -LiteralPath $target -Force).Count){throw '所选文件夹非空且不是已识别的副本目录，请另选专用空文件夹'}
    return $target
}
