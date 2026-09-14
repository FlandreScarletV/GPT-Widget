$ErrorActionPreference='Stop'
$folder=Join-Path $env:LOCALAPPDATA 'GPTWidget'
$legacyFolders=@((Join-Path $env:LOCALAPPDATA 'CodexWidget'),(Join-Path $env:LOCALAPPDATA 'CodexModelInspector'))
foreach($lf in $legacyFolders){
    if((Test-Path (Join-Path $lf 'ipapi-is.key')) -and (-not (Test-Path (Join-Path $folder 'ipapi-is.key')))){
        $folder = $lf
        break
    }
}
$path=Join-Path $folder 'ipapi-is.key'
$secret=Read-Host '把你的API密钥粘贴到这，为空则取消' -AsSecureString
if($secret.Length -eq 0){exit 0}
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$secret | ConvertFrom-SecureString | Set-Content -LiteralPath ($path+'.tmp') -Encoding ASCII
Move-Item -LiteralPath ($path+'.tmp') -Destination $path -Force
$secret.Dispose()
Write-Host '已保存。'
Read-Host '按回车键退出' | Out-Null
