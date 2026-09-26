#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Tag = 'GPT-Widget'
)

$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$output = Join-Path (Split-Path $project) 'GPT-Widget-release'
$zipPath = Join-Path $output $(if ($Tag -eq 'GPT-Widget') { 'GPT-Widget.zip' } else { "GPT-Widget-$Tag.zip" })

# Only package source needed by the launchers. Never copy runtime data, credentials,
# official application binaries, local location records, tests, or historical backups.
$files = [Collections.Generic.List[string]]::new()
$files.Add((Join-Path $project 'README.md'))
foreach ($file in Get-ChildItem -LiteralPath $project -Filter '*.cmd' -File) {
    $files.Add($file.FullName)
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $project 'internal\GPTWidget') -File) {
    if ($file.Extension -eq '.ps1' -or $file.Name -eq 'sync-config.py') {
        $files.Add($file.FullName)
    }
}
foreach ($directory in @('internal\GPTWidget\src', 'internal\GPTWidget\experimental')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $project $directory) -Filter '*.mjs' -File) {
        if ($file.Name -notlike '*.test.mjs' -and $file.Name -ne 'websocket-test-helper.mjs') {
            $files.Add($file.FullName)
        }
    }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $project 'internal\codex-model-inspector') -File) {
    if ($file.Extension -in @('.ps1', '.mjs', '.html')) {
        $files.Add($file.FullName)
    }
}

$required = @('安装.cmd', '启动副本.cmd', '同步数据.cmd',
    'internal\GPTWidget\GPTWidget.ps1',
    'internal\GPTWidget\Resolve-Location.ps1',
    'internal\GPTWidget\experimental\chat-test-lifecycle.mjs',
    'internal\GPTWidget\src\patcher.mjs',
    'internal\codex-model-inspector\server.mjs')
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $project $relative) -PathType Leaf)) {
        throw "Missing release component: $relative"
    }
}
if (Test-Path -LiteralPath $zipPath) { throw "Release already exists; choose another tag or move it first: $zipPath" }
$null = New-Item -ItemType Directory -Force -Path $output

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in @($files | Sort-Object -Unique)) {
        $absolute = [IO.Path]::GetFullPath($file)
        if (-not $absolute.StartsWith($project + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Release path escapes project: $absolute"
        }
        $item = Get-Item -LiteralPath $absolute
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Release contains a link: $absolute"
        }
        $relative = [IO.Path]::GetRelativePath($project, $absolute).Replace('\', '/')
        $entry = 'GPT-Widget/' + $relative
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $absolute, $entry, [IO.Compression.CompressionLevel]::Optimal)
    }
} catch {
    $archive.Dispose()
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    throw
} finally {
    $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($zipPath + '.sha256') -Value "$hash  $([IO.Path]::GetFileName($zipPath))" -Encoding ascii
Write-Output ([pscustomobject]@{archive=$zipPath;files=$files.Count;sha256=$hash})
