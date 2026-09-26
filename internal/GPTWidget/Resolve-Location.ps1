#requires -Version 7.0
function Resolve-WidgetLocation {
    param([string]$PackageRoot,[string]$ExplicitRoot,[string]$LocalData=$env:LOCALAPPDATA)
    $PackageRoot=[IO.Path]::GetFullPath($PackageRoot)
    $locatorPath=Join-Path $PackageRoot '.widget-location.json'
    $locator=if(Test-Path -LiteralPath $locatorPath){Get-Content -LiteralPath $locatorPath -Raw|ConvertFrom-Json}else{$null}
    function Candidate([string]$path){
        if(-not $path){return $null}
        $path=[IO.Path]::GetFullPath($path)
        $file=Join-Path $path 'current.json'
        if(-not(Test-Path -LiteralPath $file)){
            $valid=@()
            foreach($record in @(Get-ChildItem -LiteralPath (Join-Path $path 'runtimes') -Filter 'widget-runtime.json' -Recurse -ErrorAction SilentlyContinue)){
                try {
                    $old=Get-Content -LiteralPath $record.FullName -Raw|ConvertFrom-Json
                    $dir=$record.Directory.FullName
                    if([IO.Path]::GetFullPath($old.runtime).TrimEnd('\') -ne $dir){continue}
                    $asar=Join-Path $dir 'resources/app.asar'
                    $expected=if($old.patchDisabled){$old.sourceSha256}else{$old.patchedSha256}
                    if((Test-Path (Join-Path $dir 'ChatGPT.exe')) -and (Test-Path $old.backup) -and (Get-FileHash $asar).Hash -eq $expected -and (Get-FileHash $old.backup).Hash -eq $old.sourceSha256){$valid+=$record}
                } catch { }
            }
            $chosen=$valid|Sort-Object LastWriteTime -Descending|Select-Object -First 1
            if(-not $chosen){return $null}
            Copy-Item -LiteralPath $chosen.FullName -Destination $file
            Write-Host '已校验并恢复保留的旧副本启动记录。'
        }
        $m=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
        if(-not $m.runtime -or -not $m.backup){return $null}
        # Locate the same runtime and backup within the state tree after a move.
        $runtime=Join-Path $path ('runtimes/'+[IO.Path]::GetFileName($m.runtime.TrimEnd('\','/')))
        $backup=Join-Path $path ('backups/'+[IO.Path]::GetFileName([IO.Path]::GetDirectoryName($m.backup))+'/app.asar')
        $backupExe=if($m.backupExe){Join-Path (Split-Path $backup) ([IO.Path]::GetFileName($m.backupExe))}else{$null}
        if(-not(Test-Path -LiteralPath (Join-Path $runtime 'ChatGPT.exe')) -or -not(Test-Path -LiteralPath (Join-Path $runtime 'resources/app.asar')) -or -not(Test-Path -LiteralPath $backup)){return $null}
        if($backupExe -and (-not(Test-Path -LiteralPath $backupExe) -or ($m.sourceExeSha256 -and (Get-FileHash -LiteralPath $backupExe).Hash -ne $m.sourceExeSha256))){return $null}
        [pscustomobject]@{StateRoot=$path;Runtime=$runtime;Backup=$backup;BackupExe=$backupExe;Manifest=$m;OldState=[IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($m.runtime));Source='';PackageRoot=$PackageRoot}
    }
    if($ExplicitRoot){$root=[IO.Path]::GetFullPath($ExplicitRoot);$found=Candidate $root;if($found){$found.Source='explicit';return $found};return [pscustomobject]@{StateRoot=$root;Manifest=$null;Source='explicit-new';PackageRoot=$PackageRoot}}
    # Portable local data wins over old machine-wide records.
    $local=@((Join-Path $PackageRoot '.local-state'),(Join-Path $PackageRoot 'internal/GPTWidget/.local-state'),(Join-Path $PackageRoot 'internal/.local-state'),(Join-Path $PackageRoot 'internal/CodexModelInspector/.local-state'))
    foreach($p in $local){$found=Candidate $p;if($found){$found.Source='package-local';return $found}}
    if($locator){
        if($locator.stateRelative){$found=Candidate ([IO.Path]::GetFullPath([string]$locator.stateRelative,$PackageRoot));if($found){$found.Source='package-relative';return $found}}
        if($locator.stateAbsolute){$found=Candidate $locator.stateAbsolute;if($found){$found.Source='package-record';return $found}}
        throw '已记录的副本已移动或缺失，拒绝创建新环境。请将副本数据目录一起迁移，或用 -StateRoot 明确指定原目录。'
    }
    foreach($brand in @('CodexWidget','CodexModelInspector')){
        $record=Join-Path $LocalData ($brand+'/runtime-state.txt')
        if(Test-Path -LiteralPath $record){$found=Candidate ((Get-Content -LiteralPath $record -Raw).Trim());if($found){$found.Source='legacy-'+$brand;return $found}}
    }
    $nearby=@()
    $parent=Split-Path $PackageRoot
    foreach($folder in (Get-ChildItem -LiteralPath $parent -Directory)){
        foreach($relative in @('.local-state','internal/GPTWidget/.local-state','internal/CodexModelInspector/.local-state')){
            $found=Candidate (Join-Path $folder.FullName $relative);if($found){$nearby+=$found}
        }
    }
    $nearby=@($nearby|Sort-Object StateRoot -Unique)
    if($nearby.Count -eq 1){$nearby[0].Source='nearby-existing';return $nearby[0]}
    if($nearby.Count -gt 1){throw ('找到多个旧副本，请用 -StateRoot 选择，不会自动新建：'+($nearby.StateRoot -join '；'))}
    # Never fall back to C:\Users when starting a new installation.
    [pscustomobject]@{StateRoot=(Join-Path $PackageRoot '.local-state');Manifest=$null;Source='new-package-local';PackageRoot=$PackageRoot}
}
function Save-WidgetLocation {
    param($Location)
    $root=$Location.StateRoot
    if($Location.Manifest){
        $m=$Location.Manifest
        if($m.runtime -ne $Location.Runtime -or $m.backup -ne $Location.Backup -or ($m.backupExe -and $m.backupExe -ne $Location.BackupExe)){
            $file=Join-Path $root 'current.json'
            Copy-Item -LiteralPath $file -Destination ($file+'.before-relocation-'+[guid]::NewGuid().ToString('N'))
            $m.runtime=$Location.Runtime;$m.backup=$Location.Backup
            if($m.backupExe){$m.backupExe=$Location.BackupExe}
            $m|ConvertTo-Json -Depth 12|Set-Content -LiteralPath ($file+'.relocation-tmp')
            Move-Item -LiteralPath ($file+'.relocation-tmp') -Destination $file -Force
        }
        $envFile=Join-Path $root 'environment.json'
        if(Test-Path -LiteralPath $envFile){
            $settings=Get-Content -LiteralPath $envFile -Raw|ConvertFrom-Json
            $changed=$false
            foreach($key in @('profile','codexHome')){
                $p=[string]$settings.$key
                $old=$Location.OldState.TrimEnd('\','/')
                if($p -and $p.StartsWith($old+'\',[StringComparison]::OrdinalIgnoreCase)){
                    $next=Join-Path $root $p.Substring($old.Length+1)
                    if($next -ne $p){if(-not(Test-Path -LiteralPath $next)){throw "迁移后的用户数据缺失，停止启动：$next"};$settings.$key=$next;$changed=$true}
                }
            }
            if($changed){Copy-Item -LiteralPath $envFile -Destination ($envFile+'.before-relocation-'+[guid]::NewGuid().ToString('N'));$settings|ConvertTo-Json|Set-Content -LiteralPath ($envFile+'.relocation-tmp');Move-Item -LiteralPath ($envFile+'.relocation-tmp') -Destination $envFile -Force}
        }
    }
    $record=Join-Path $Location.PackageRoot '.widget-location.json'
    @{version=1;stateRelative=[IO.Path]::GetRelativePath($Location.PackageRoot,$root);stateAbsolute=$root}|ConvertTo-Json|Set-Content -LiteralPath ($record+'.tmp')
    Move-Item -LiteralPath ($record+'.tmp') -Destination $record -Force
}
