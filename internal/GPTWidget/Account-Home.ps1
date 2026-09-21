function Initialize-WidgetAccountHome([string]$StateRoot, [string]$WorkHome) {
    $work = [IO.Path]::GetFullPath($WorkHome).TrimEnd('\')
    $private = [IO.Path]::GetFullPath((Join-Path $StateRoot 'account-home')).TrimEnd('\')
    if ($private -eq $work -or $private.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '独立账号目录不能放在共享工作目录内。' }
    if (-not (Test-Path -LiteralPath $work -PathType Container)) { throw '共享工作目录不存在。' }
    $null = New-Item -ItemType Directory -Force -Path $private
    if ((Get-Item -LiteralPath $private).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '账号目录不能是目录链接。' }
    foreach ($name in @('sessions','archived_sessions')) {
        $source = Join-Path $work $name
        $link = Join-Path $private $name
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw ('工作会话目录缺失：'+$source) }
        if (Test-Path -LiteralPath $link) {
            $item = Get-Item -LiteralPath $link -Force
            if ($item.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath([string]$item.Target).TrimEnd('\') -ne $source) { throw ('已有会话目录与选择不符，未覆盖：'+$link) }
        } else { $null = New-Item -ItemType Junction -Path $link -Target $source }
    }
    $config = Join-Path $private 'config.toml'
    if (-not (Test-Path -LiteralPath $config)) {
        Set-Content -LiteralPath $config -Encoding utf8 -Value 'cli_auth_credentials_store = "file"'
    } elseif ((Get-Content -LiteralPath $config -Raw) -notmatch '(?m)^cli_auth_credentials_store\s*=\s*"file"\s*$') {
        throw '独立账号配置必须使用 file 凭据存储；未自动覆盖已有配置。'
    }
    return $private
}
