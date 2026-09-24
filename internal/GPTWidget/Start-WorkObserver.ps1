function Start-WidgetWorkObserver {
    param([string]$Node,[string]$Runtime,[string]$StateRoot)
    $control=Join-Path $StateRoot 'work-observer-control'
    $null=New-Item -ItemType Directory -Force -Path $control
    $key=[guid]::NewGuid().ToString('N')
    $owner=Join-Path $control ($key+'.owner.json')
    $ready=Join-Path $control ($key+'.ready.json')
    @{pid=$PID}|ConvertTo-Json -Compress|Set-Content -LiteralPath $owner -Encoding utf8
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$Node;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $info.ArgumentList.Add((Join-Path $PSScriptRoot 'experimental/work-observer-worker.mjs'))
    $info.ArgumentList.Add((Join-Path $Runtime 'resources/inspector-work-state.json'))
    $info.ArgumentList.Add($ready);$info.ArgumentList.Add($owner)
    $worker=[Diagnostics.Process]::Start($info)
    for($attempt=0;$attempt -lt 50;$attempt++){
        if(Test-Path -LiteralPath $ready){
            $result=Get-Content -Raw -LiteralPath $ready|ConvertFrom-Json
            if($result.pid -ne $worker.Id -or $result.baseUrl -notmatch '^http://127\.0\.0\.1:\d+/[a-f0-9]{48}/backend-api/codex$'){break}
            return @{process=$worker;owner=$owner;baseUrl=$result.baseUrl}
        }
        if($worker.HasExited){break};Start-Sleep -Milliseconds 100
    }
    if(-not $worker.HasExited){$worker.Kill()}
    throw '模型观测代理启动失败，未启动副本；请检查 Node 和运行目录。'
}
