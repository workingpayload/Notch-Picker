# Long-running helper: reports whether the foreground window is full-screen, Windows'
# notification state (presentation mode / quiet time) and the foreground window handle.
# Prints one JSON line whenever any of these change:
#   {"quns":5,"fullscreen":null,"fg":1836332}
#   {"quns":2,"fullscreen":{"x":0,"y":0,"width":1920,"height":1200},"fg":4657504}   (physical pixels)
#   {"quns":5,"fullscreen":null,"fg":1836332,"fgApp":"chrome","fgRect":{"x":0,"y":0,"width":1920,"height":1152}}
#   (fgApp / fgRect: the foreground app's process name and visible frame; absent for the shell)
# With "windows on", it also prints the visible app windows (for desktop pets) when they change:
#   {"windows":[[hwnd,left,top,right,bottom,cover],...]}   (topmost first, physical pixels; cover = maximized)
# and the desktop icons (the top of each icon's picture) when they change:
#   {"icons":[[left,top,right,bottom],...]}   (physical pixels; [] when desktop icons are hidden)
# With "wsl on", it also prints the open WSL terminals per distro (wsl.exe processes and distro
# launchers, apart from Docker Desktop's and the app's own), whenever they change: {"wslClients":{"Ubuntu":2}}
# Reads commands on stdin: "focus <hwnd>" brings that window to the foreground; "windows on|off"; "wsl on|off".
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

  static uint lastPid;
  static string lastApp = "";

  // The foreground app (process name) and its visible frame, for "hide over tabs", as JSON
  // members to append (",\"fgApp\":\"chrome\",\"fgRect\":{...}"), or "" (none, minimized, shell).
  public static string ForegroundApp() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero || !IsWindowVisible(h) || IsIconic(h)) return "";
    var cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    if (Array.IndexOf(ShellClasses, cls.ToString()) >= 0) return "";
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return "";
    if (pid != lastPid) {
      try { lastApp = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { lastApp = ""; }
      lastPid = pid;
    }
    if (lastApp.Length == 0) return "";
    RECT r;
    if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, 16) != 0 && !GetWindowRect(h, out r)) return "";
    string app = lastApp.Replace("\\", "\\\\").Replace("\"", "\\\"");
    return ",\"fgApp\":\"" + app + "\",\"fgRect\":{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}";
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

  // ---- Desktop icons, for desktop pets to stand on ----
  // Through the shell's own desktop view (IShellWindows -> IFolderView), as Explorer documents it,
  // rather than reading Explorer's memory. UI Automation doesn't list the desktop's items.

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

  [ComImport, Guid("85CB6900-4D95-11CF-960C-0080C7F4EE85"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
  interface IShellWindows {
    int Count { get; }
    [return: MarshalAs(UnmanagedType.IDispatch)] object Item(object index);
    [return: MarshalAs(UnmanagedType.IUnknown)] object _NewEnum();
    void Register([MarshalAs(UnmanagedType.IDispatch)] object d, int h, int c, out int cookie);
    void RegisterPending(int tid, ref object loc, ref object rootLoc, int c, out int cookie);
    void Revoke(int cookie);
    void OnNavigate(int cookie, ref object loc);
    void OnActivated(int cookie, bool active);
    [return: MarshalAs(UnmanagedType.IDispatch)] object FindWindowSW(ref object loc, ref object root, int swClass, out int hwnd, int options);
  }
  [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IServiceProvider { [PreserveSig] int QueryService(ref Guid sid, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellBrowser {
    void GetWindow(out IntPtr h); void ContextSensitiveHelp(bool b);
    void InsertMenusSB(IntPtr a, IntPtr b); void SetMenuSB(IntPtr a, IntPtr b, IntPtr c); void RemoveMenusSB(IntPtr a);
    void SetStatusTextSB(IntPtr a); void EnableModelessSB(bool b); void TranslateAcceleratorSB(IntPtr a, short b);
    void BrowseObject(IntPtr a, uint b); void GetViewStateStream(uint a, out IntPtr b); void GetControlWindow(uint a, out IntPtr b);
    void SendControlMsg(uint a, uint b, IntPtr c, IntPtr d, out IntPtr e);
    void QueryActiveShellView([MarshalAs(UnmanagedType.IUnknown)] out object view);
  }
  [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellView { void GetWindow(out IntPtr h); }
  [ComImport, Guid("cde725b0-ccc9-4519-917e-325d72fab4ce"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFolderView {
    void GetCurrentViewMode(out uint m); void SetCurrentViewMode(uint m); void GetFolder(ref Guid iid, out IntPtr p);
    void Item(int i, out IntPtr pidl); void ItemCount(uint flags, out int n); void Items(uint f, ref Guid iid, out IntPtr p);
    void GetSelectionMarkedItem(out int i); void GetFocusedItem(out int i);
    void GetItemPosition(IntPtr pidl, out POINT pt); void GetSpacing(ref POINT pt);
  }

  [DllImport("user32.dll")] static extern int MapWindowPoints(IntPtr from, IntPtr to, ref POINT p, int n);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);

  static IFolderView desktopView;
  static IntPtr desktopList;

  static bool OpenDesktopView() {
    var windows = (IShellWindows)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));
    object loc = 0 /* CSIDL_DESKTOP */, root = null;
    int hwnd;
    object disp = windows.FindWindowSW(ref loc, ref root, 8 /* SWC_DESKTOP */, out hwnd, 1 /* SWFO_NEEDDISPATCH */);
    if (disp == null) return false;
    var sid = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837"); // SID_STopLevelBrowser
    var iid = typeof(IShellBrowser).GUID;
    object browser;
    if (((IServiceProvider)disp).QueryService(ref sid, ref iid, out browser) != 0 || browser == null) return false;
    object view;
    ((IShellBrowser)browser).QueryActiveShellView(out view);
    IntPtr defView;
    ((IShellView)view).GetWindow(out defView);
    desktopList = FindWindowEx(defView, IntPtr.Zero, "SysListView32", null);
    desktopView = (IFolderView)view;
    return desktopList != IntPtr.Zero;
  }

  // The desktop's icon size in DIPs (View > Large/Medium/Small icons, Ctrl+wheel).
  static int DesktopIconSize() {
    try {
      object v = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\Shell\Bags\1\Desktop", "IconSize", 48);
      int size = v is int ? (int)v : 48;
      return size >= 16 && size <= 256 ? size : 48;
    } catch { return 48; }
  }

  // The tops of the desktop icons, as JSON: [[left,top,right,bottom],...] in physical pixels: the
  // icon picture's top edge (not its label), a little narrower than the icon. "[]" when the desktop
  // icons are hidden, null when the desktop can't be read right now (keep the last answer).
  public static string DesktopIcons() {
    try {
      if (desktopView == null && !OpenDesktopView()) return null;
      if (!IsWindow(desktopList)) { desktopView = null; return null; }
      if (!IsWindowVisible(desktopList)) return "[]";
      uint mode;
      desktopView.GetCurrentViewMode(out mode);
      if (mode != 1 /* FVM_ICON */) return "[]";
      int count;
      desktopView.ItemCount(2 /* SVGIO_ALLVIEW */, out count);
      var spacing = new POINT();
      desktopView.GetSpacing(ref spacing);
      uint dpi = GetDpiForWindow(desktopList);
      int icon = (int)Math.Round(DesktopIconSize() * (dpi > 0 ? dpi : 96) / 96.0);
      int half = (int)Math.Round(icon * 0.4), inset = (int)Math.Round(icon * 0.12);
      var sb = new StringBuilder("[");
      for (int i = 0; i < count && i < 500; i++) {
        IntPtr pidl;
        desktopView.Item(i, out pidl);
        POINT p;
        try { desktopView.GetItemPosition(pidl, out p); } finally { Marshal.FreeCoTaskMem(pidl); }
        MapWindowPoints(desktopList, IntPtr.Zero, ref p, 1);
        int cx = p.X + spacing.X / 2;
        if (i > 0) sb.Append(',');
        sb.Append('[').Append(cx - half).Append(',').Append(p.Y + inset).Append(',').Append(cx + half).Append(',').Append(p.Y + icon).Append(']');
      }
      return sb.Append(']').ToString();
    } catch {
      // Explorer restarted, or the desktop is being rebuilt: reconnect next time.
      desktopView = null;
      return null;
    }
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
$lastIcons = ''
$iconsMs = 1500
$iconsElapsed = 0
$trackWsl = $false
$wslMs = 2000
$wslElapsed = 0
$lastWsl = $null
$wslSeen = @{}  # wsl.exe / launcher PID -> the distro it's a terminal for ('' = not a terminal), looked up once
$wslProcs = @{} # PID -> Process of each counted terminal, checked for exit on every tick
$lxss = @{ At = [datetime]::MinValue; Names = @{}; Default = ''; Launchers = @{} }

# Registered distros (refreshed every minute): GUID -> name, the default distro, and launcher
# process names (ubuntu2204 for Ubuntu-22.04).
function Update-Lxss {
  if (((Get-Date) - $lxss.At).TotalSeconds -lt 60) { return }
  $lxss.At = Get-Date
  $names = @{}
  $launchers = @{}
  $default = ''
  try {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    $defaultId = ([string](Get-ItemProperty -Path $key -ErrorAction Stop).DefaultDistribution).Trim('{}').ToLowerInvariant()
    foreach ($sub in Get-ChildItem -Path $key -ErrorAction Stop) {
      $name = [string](Get-ItemProperty -Path $sub.PSPath -ErrorAction SilentlyContinue).DistributionName
      if (-not $name -or $name -match '^docker-desktop') { continue }
      $id = $sub.PSChildName.Trim('{}').ToLowerInvariant()
      $names[$id] = $name
      $launchers[($name -replace '[^A-Za-z0-9]', '').ToLowerInvariant()] = $name
      if ($id -eq $defaultId) { $default = $name }
    }
  } catch { }
  $lxss.Names = $names
  $lxss.Launchers = $launchers
  $lxss.Default = $default
}

# The distro a wsl.exe command line opens a terminal on, or '' (Docker Desktop's, management
# commands such as wsl --list / --shutdown, unknown distros).
function Get-WslTarget([string]$cl) {
  if ($cl -match 'docker-desktop') { return '' }
  if ($cl -match '(?i)\s(?:-l|--list|--shutdown|-t|--terminate|--status|--update|--install|--unregister|--export|--import|-s|--set-default|--set-version|--set-default-version|--mount|--unmount|--manage|--version|--help)(?:\s|$)') { return '' }
  if ($cl -match '(?i)\s(?:-d|--distribution)\s+"?([^"\s]+)') {
    $want = $Matches[1]
    foreach ($name in $lxss.Names.Values) { if ($name -ieq $want) { return $name } }
    return ''
  }
  if ($cl -match '(?i)\s--distribution-id\s+"?\{?([0-9a-f-]{36})') {
    $id = $Matches[1].ToLowerInvariant()
    if ($lxss.Names.ContainsKey($id)) { return $lxss.Names[$id] }
    return ''
  }
  return $lxss.Default
}

# The distro a process is a terminal for. The app's own wsl.exe calls (git status, distro list)
# don't count, and a wsl.exe started by another wsl.exe counts the same as its parent.
function Get-ClientDistro($proc, $ids, [int]$depth = 0) {
  if ($wslSeen.ContainsKey($proc.Id)) { return $wslSeen[$proc.Id] }
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -Property ParentProcessId, CommandLine -ErrorAction SilentlyContinue
  $distro = ''
  if ($info -and [int]$info.ParentProcessId -ne $ParentPid) {
    $parentId = [int]$info.ParentProcessId
    $parent = if ($depth -lt 3 -and $ids -contains $parentId) { Get-Process -Id $parentId -ErrorAction SilentlyContinue } else { $null }
    if ($proc.ProcessName -ne 'wsl') { $distro = [string]$lxss.Launchers[$proc.ProcessName.ToLowerInvariant()] }
    elseif ($parent -and $parent.ProcessName -eq 'wsl') { $distro = Get-ClientDistro $parent $ids ($depth + 1) }
    else { $distro = Get-WslTarget ([string]$info.CommandLine) }
  }
  $wslSeen[$proc.Id] = $distro
  if ($distro) { $wslProcs[$proc.Id] = $proc }
  return $distro
}

function Update-WslClients {
  Update-Lxss
  $procs = @(Get-Process -Name (@('wsl') + @($lxss.Launchers.Keys)) -ErrorAction SilentlyContinue)
  $ids = @($procs | ForEach-Object { $_.Id })
  foreach ($k in @($wslSeen.Keys)) { if ($ids -notcontains $k) { $wslSeen.Remove($k); $wslProcs.Remove($k) } }
  foreach ($p in $procs) { [void](Get-ClientDistro $p $ids) }
}

# Drops counted terminals that exited; true if any did.
function Remove-ExitedWslClients {
  $gone = $false
  foreach ($k in @($wslProcs.Keys)) {
    $exited = $false
    try { $exited = $wslProcs[$k].HasExited } catch { }
    if ($exited) { $wslProcs.Remove($k); $wslSeen[$k] = ''; $gone = $true }
  }
  return $gone
}

function Write-WslClients {
  $counts = @{}
  foreach ($k in $wslProcs.Keys) { $d = $wslSeen[$k]; if ($d) { $counts[$d] = 1 + [int]$counts[$d] } }
  $key = (($counts.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ',')
  if ($key -ceq $lastWsl) { return }
  $script:lastWsl = $key
  [Console]::Out.WriteLine((@{ wslClients = $counts } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$tickMs = 100
$elapsed = $IntervalMs
while ($true) {
  # Commands from the app, one per line: "focus <hwnd>", "windows on|off", "wsl on|off". EOF means the app went away.
  if ($pending.IsCompleted) {
    $cmd = $pending.Result
    if ($null -eq $cmd) { exit 0 }
    if ($cmd -match '^focus (\d+)$') { [void][NotchFullscreen]::Focus([long]$Matches[1]); $elapsed = $IntervalMs }
    if ($cmd -eq 'windows on') { $trackWindows = $true; $lastWindows = ''; $windowsElapsed = $windowsMs; $lastIcons = ''; $iconsElapsed = $iconsMs }
    if ($cmd -eq 'windows off') { $trackWindows = $false }
    if ($cmd -eq 'wsl on') { $trackWsl = $true; $lastWsl = $null; $wslElapsed = $wslMs }
    if ($cmd -eq 'wsl off') { $trackWsl = $false }
    $pending = $stdin.ReadLineAsync()
  }
  # Open WSL terminals per distro, as {"wslClients":{"Ubuntu":1}}: rescanned every 2 s, and a
  # terminal's exit (e.g. by wsl --shutdown) is reported within a tick.
  if ($trackWsl) {
    $changed = $false
    try { $changed = Remove-ExitedWslClients } catch { }
    if ($wslElapsed -ge $wslMs) {
      $wslElapsed = 0
      try { Update-WslClients } catch { }
      $changed = $true
    }
    if ($changed) { Write-WslClients }
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
  # Desktop icons (pets stand on them too), as {"icons":[[l,t,r,b],...]} whenever they change.
  if ($trackWindows -and $iconsElapsed -ge $iconsMs) {
    $iconsElapsed = 0
    $icons = [NotchFullscreen]::DesktopIcons()
    if ($null -ne $icons -and $icons -ne $lastIcons) {
      [Console]::Out.WriteLine('{"icons":' + $icons + '}')
      [Console]::Out.Flush()
      $lastIcons = $icons
    }
  }
  if ($elapsed -ge $IntervalMs) {
    $elapsed = 0
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
    $quns = [NotchFullscreen]::Quns()
    $fs = [NotchFullscreen]::FullscreenMonitor($quns)
    $fg = [NotchFullscreen]::Foreground()
    $fgApp = [NotchFullscreen]::ForegroundApp()
    $line = '{"quns":' + $quns + ',"fullscreen":' + $(if ($fs) { $fs } else { 'null' }) + ',"fg":' + $fg + $fgApp + '}'
    if ($line -ne $last) {
      [Console]::Out.WriteLine($line)
      [Console]::Out.Flush()
      $last = $line
    }
  }
  Start-Sleep -Milliseconds $tickMs
  $elapsed += $tickMs
  $windowsElapsed += $tickMs
  $iconsElapsed += $tickMs
  $wslElapsed += $tickMs
}
