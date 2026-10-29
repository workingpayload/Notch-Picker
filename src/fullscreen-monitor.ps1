# Long-running helper: reports whether the foreground window is full-screen, Windows'
# notification state (presentation mode / quiet time) and the foreground window handle.
# Prints one JSON line whenever any of these change:
#   {"quns":5,"fullscreen":null,"fg":1836332}
#   {"quns":2,"fullscreen":{"x":0,"y":0,"width":1920,"height":1200},"fg":4657504}   (physical pixels)
# With "windows on", it also prints the visible app windows (for desktop pets) when they change:
#   {"windows":[[hwnd,left,top,right,bottom,cover],...]}   (topmost first, physical pixels; cover = maximized)
# Reads commands on stdin: "focus <hwnd>" brings that window to the foreground; "windows on|off".
param([int]$IntervalMs = 700, [int]$ParentPid = 0)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NotchFullscreen {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

  const int GWL_STYLE = -16;
  const int WS_CAPTION = 0x00C00000;
  static readonly string[] ShellClasses = {
    "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "ForegroundStaging"
  };

  public static void Init() {
    // Per-monitor v2 so rectangles are physical pixels on every display.
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
  }

  public static int Quns() {
    int s;
    return SHQueryUserNotificationState(out s) == 0 ? s : 0;
  }

  // Monitor rectangle covered by a full-screen foreground window, or null.
  public static string FullscreenMonitor(int quns) {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero || !IsWindowVisible(h)) return null;
    var cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    if (Array.IndexOf(ShellClasses, cls.ToString()) >= 0) return null;

    RECT w;
    if (!GetWindowRect(h, out w)) return null;
    var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref info)) return null;
    RECT m = info.rcMonitor;

    bool covers = w.Left <= m.Left && w.Top <= m.Top && w.Right >= m.Right && w.Bottom >= m.Bottom;
    bool captionless = (GetWindowLong(h, GWL_STYLE) & WS_CAPTION) != WS_CAPTION;
    // QUNS_BUSY (2) / QUNS_RUNNING_D3D_FULL_SCREEN (3) is Windows' own full-screen signal.
    bool fullscreen = covers && (captionless || quns == 2 || quns == 3);
    if (!fullscreen) return null;
    return "{\"x\":" + m.Left + ",\"y\":" + m.Top + ",\"width\":" + (m.Right - m.Left) + ",\"height\":" + (m.Bottom - m.Top) + "}";
  }

  public static long Foreground() {
    return GetForegroundWindow().ToInt64();
  }

  // ---- App windows, for desktop pets to walk on ----

  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

  // Visible app windows, topmost first, as JSON: [[hwnd,left,top,right,bottom,cover],...] in
  // physical pixels (the visible frame, without the invisible resize border). cover = 1 marks a
  // maximized window: it hides the windows behind it but isn't somewhere to stand (its top is the
  // top of the screen). Skips minimized windows, tool windows, click-through overlays, cloaked
  // windows (other virtual desktops, suspended apps), the shell, tiny windows and our own
  // process's windows.
  public static string Windows(int ownPid) {
    var sb = new StringBuilder("[");
    bool first = true;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
      int ex = GetWindowLong(h, GWL_EXSTYLE);
      if ((ex & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) != 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == (uint)ownPid || GetWindowTextLength(h) == 0) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      if (Array.IndexOf(ShellClasses, cls.ToString()) >= 0) return true;
      RECT r;
      if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, 16) != 0 && !GetWindowRect(h, out r)) return true;
      if (r.Right - r.Left < 150 || r.Bottom - r.Top < 100) return true;
      if (!first) sb.Append(',');
      first = false;
      sb.Append('[').Append(h.ToInt64()).Append(',').Append(r.Left).Append(',').Append(r.Top).Append(',').Append(r.Right).Append(',').Append(r.Bottom).Append(',').Append(IsZoomed(h) ? 1 : 0).Append(']');
      return true;
    }, IntPtr.Zero);
    return sb.Append(']').ToString();
  }

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  // Gives focus back to a window (the notch takes focus for keyboard use while pinned).
  public static bool Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return false;
    // A synthetic Alt press lifts the foreground lock for background processes.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(h);
  }
}
'@

[NotchFullscreen]::Init()
$last = ''
$lastWindows = ''
$trackWindows = $false
$windowsMs = 300
$windowsElapsed = 0
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$tickMs = 100
$elapsed = $IntervalMs
while ($true) {
  # Commands from the app, one per line: "focus <hwnd>", "windows on|off". EOF means the app went away.
  if ($pending.IsCompleted) {
    $cmd = $pending.Result
    if ($null -eq $cmd) { exit 0 }
    if ($cmd -match '^focus (\d+)$') { [void][NotchFullscreen]::Focus([long]$Matches[1]); $elapsed = $IntervalMs }
    if ($cmd -eq 'windows on') { $trackWindows = $true; $lastWindows = ''; $windowsElapsed = $windowsMs }
    if ($cmd -eq 'windows off') { $trackWindows = $false }
    $pending = $stdin.ReadLineAsync()
  }
  # App windows (for desktop pets), as {"windows":[[hwnd,l,t,r,b],...]} whenever they change.
  if ($trackWindows -and $windowsElapsed -ge $windowsMs) {
    $windowsElapsed = 0
    $wins = [NotchFullscreen]::Windows($ParentPid)
    if ($wins -ne $lastWindows) {
      [Console]::Out.WriteLine('{"windows":' + $wins + '}')
      [Console]::Out.Flush()
      $lastWindows = $wins
    }
  }
  if ($elapsed -ge $IntervalMs) {
    $elapsed = 0
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
    $quns = [NotchFullscreen]::Quns()
    $fs = [NotchFullscreen]::FullscreenMonitor($quns)
    $fg = [NotchFullscreen]::Foreground()
    $line = '{"quns":' + $quns + ',"fullscreen":' + $(if ($fs) { $fs } else { 'null' }) + ',"fg":' + $fg + '}'
    if ($line -ne $last) {
      [Console]::Out.WriteLine($line)
      [Console]::Out.Flush()
      $last = $line
    }
  }
  Start-Sleep -Milliseconds $tickMs
  $elapsed += $tickMs
  $windowsElapsed += $tickMs
}
