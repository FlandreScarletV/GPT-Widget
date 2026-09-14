param([switch]$ChooseInstallDirectory,[switch]$ChooseDataDirectory,[switch]$Tested,[switch]$Check,[switch]$Restart,[switch]$UseOfficialData,[ValidateSet('Launch','LaunchPrepared','Prepare','Restore','Enable')][string]$Mode='Launch')
$ErrorActionPreference='Stop'
$candidates=@(
    (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\PowerShell\7\pwsh.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe')
)
$found=Get-Command pwsh.exe -ErrorAction SilentlyContinue
if($found){$candidates=@($found.Source)+$candidates}
$runtime=$candidates | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf} | Select-Object -First 1
if(-not $runtime){Write-Error 'PowerShell 7 was not found. Install PowerShell 7 and retry.';exit 1}
if($Check){& $runtime -NoProfile -Command '$PSVersionTable.PSVersion.ToString()';exit $LASTEXITCODE}
$launchArgs=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'GPTWidget.ps1'),'-Mode',$Mode)
if($Tested){
    if($Mode -eq 'Launch'){$launchArgs[$launchArgs.Length-1]='LaunchPrepared'}
    $testState = Join-Path $PSScriptRoot '..\.local-state'
    $launchArgs+=@('-StateRoot',$testState,'-ProfileDirectory',(Join-Path $testState 'profile'),'-CodexDirectory',(Join-Path $testState 'codex-home'))
}
if($ChooseInstallDirectory){$launchArgs+='-ChooseInstallDirectory'}
if($ChooseDataDirectory){$launchArgs+='-ChooseDataDirectory'}
if($Restart){$launchArgs+='-Restart'}
if($UseOfficialData){$launchArgs+='-UseOfficialData'}
& $runtime @launchArgs
exit $LASTEXITCODE

