param([int[]]$ProcessIds)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class InspectorWindow {
 public delegate bool Callback(IntPtr window, IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int count);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
$script:shown = 0
$script:windows = @()
$callback = [InspectorWindow+Callback]{ param($window,$data)
    [uint32]$ownerId = 0
    $null = [InspectorWindow]::GetWindowThreadProcessId($window,[ref]$ownerId)
    if ($ownerId -in $ProcessIds) {
        $className = [Text.StringBuilder]::new(256)
        $null = [InspectorWindow]::GetClassName($window,$className,256)
        $title = [Text.StringBuilder]::new(512)
        $null = [InspectorWindow]::GetWindowText($window,$title,512)
        # Electron's hidden auxiliary window has the same class as the main window.
        # Never make unnamed windows visible merely because their class matches.
        if ($className.ToString() -eq 'Chrome_WidgetWin_1' -and $title.ToString() -in @('ChatGPT','Codex')) {
            $null = [InspectorWindow]::ShowWindowAsync($window,9)
            $null = [InspectorWindow]::SetForegroundWindow($window)
            $script:shown++
            $script:windows += $window
        }
    }
    return $true
}
$null = [InspectorWindow]::EnumWindows($callback,[IntPtr]::Zero)
Start-Sleep -Milliseconds 200
$visible = @($script:windows | Where-Object { [InspectorWindow]::IsWindowVisible($_) })
if (-not $visible.Count) { throw '副本进程存在，但主窗口未能显示。请使用 Restart Inspector.cmd 重新打开副本。' }
Write-Output '已显示正在运行的 Inspector 独立副本。'
