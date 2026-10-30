# Brings the terminal window hosting a Copilot CLI process to the foreground.
# Usage: focus-terminal.ps1 -TargetPid <pid> [-FindOnly]
#        focus-terminal.ps1 -WslDistro <name> [-Folder <name>] [-VsCode] [-AppPid <pid>]   (a session inside WSL)
# Prints "ok <method> <hwnd>" on success ("found <method> <hwnd>" with -FindOnly, which does not
# change focus) or "notfound" and exits 1.
param([int]$TargetPid = 0, [switch]$FindOnly, [string]$WslDistro = '', [string]$Folder = '', [switch]$VsCode, [int]$AppPid = 0)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NotchFocus {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);

  const uint GA_ROOTOWNER = 3;
  const uint GW_OWNER = 4;

  // The console attached to the process. Under Windows Terminal / ConPTY this is a
  // PseudoConsoleWindow whose root owner is the real terminal window.
  public static IntPtr ConsoleWindowOf(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return IntPtr.Zero;
    IntPtr h = GetConsoleWindow();
    FreeConsole();
    if (h == IntPtr.Zero) return h;
    IntPtr root = GetAncestor(h, GA_ROOTOWNER);
    if (root != IntPtr.Zero && root != h && IsWindowVisible(root)) return root;
    IntPtr owner = GetWindow(h, GW_OWNER);
    if (owner != IntPtr.Zero && IsWindowVisible(owner)) return owner;
    return IsWindowVisible(h) ? h : IntPtr.Zero;
  }

  public static IntPtr TopWindowOf(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);

  public static string TitleOf(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static uint OwnerOf(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  // Visible top-level windows whose title contains the text (e.g. VS Code's "[WSL: Ubuntu]").
  public static List<IntPtr> WindowsTitled(string part) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && TitleOf(h).IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    uint ignored;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    uint self = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != self && AttachThreadInput(self, fgThread, true);
    // A synthetic Alt press lifts the foreground lock for background processes.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(self, fgThread, false);
    if (GetForegroundWindow() != h) SwitchToThisWindow(h, true);
    return GetForegroundWindow() == h;
  }
}
'@

function Write-Result([string]$method, [IntPtr]$hwnd) {
  if ($FindOnly) {
    "found $method $hwnd"
    exit 0
  }
  $ok = [NotchFocus]::Focus($hwnd)
  "ok $method $hwnd foreground=$ok"
  exit 0
}

$stopAt = @('explorer.exe', 'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'sihost.exe', 'userinit.exe')
$procs = @{}

# The window hosting a console process: its console window, or else the first titled window of an
# ancestor (Windows Terminal, VS Code, etc. own the visible window). The walk stops at shell/system
# processes so an unrelated Explorer window is never focused. Returns @(method, hwnd) or $null.
function Find-HostWindow([int]$procId) {
  $h = [NotchFocus]::ConsoleWindowOf([uint32]$procId)
  if ($h -ne [IntPtr]::Zero) { return @('console', $h) }
  $id = $procId
  for ($i = 0; $i -lt 12 -and $id -gt 4; $i++) {
    if (-not $procs.ContainsKey($id) -or $stopAt -contains $procs[$id].Name) { break }
    $h = [NotchFocus]::TopWindowOf([uint32]$id)
    if ($h -ne [IntPtr]::Zero) { return @("ancestor:$id", $h) }
    $id = $procs[$id].Parent
  }
  return $null
}

# A session inside WSL: its Linux PID can't be traced to a Windows process, so look for the windows
# connected to the distro: terminals running wsl.exe for it (or its launcher, e.g. ubuntu2204.exe)
# and VS Code windows opened on it ("… [WSL: Ubuntu] - Visual Studio Code"). Prefer VS Code or a
# terminal as hinted, then a window whose title mentions the session's folder.
if ($WslDistro) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine)
  foreach ($p in $all) { $procs[[int]$p.ProcessId] = @{ Parent = [int]$p.ParentProcessId; Name = ([string]$p.Name).ToLowerInvariant() } }
  # The default distro (plain `wsl`), and this distro's ID: Windows Terminal's profiles run
  # wsl.exe --distribution-id {GUID}.
  $default = ''
  $distroId = ''
  try {
    $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    $defaultId = ([string](Get-ItemProperty -Path $lxss).DefaultDistribution).Trim('{}')
    foreach ($sub in Get-ChildItem -Path $lxss) {
      $name = [string](Get-ItemProperty -Path $sub.PSPath -ErrorAction SilentlyContinue).DistributionName
      $id = $sub.PSChildName.Trim('{}')
      if ($id -eq $defaultId) { $default = $name }
      if ($name -eq $WslDistro) { $distroId = $id }
    }
  } catch { }
  $launcher = ($WslDistro -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
  $distroArg = '(?i)(?:^|\s)(?:-d|--distribution)\s+"?' + [regex]::Escape($WslDistro) + '"?(?:\s|$)'
  $idArg = if ($distroId) { '(?i)\s--distribution-id\s+"?\{?' + [regex]::Escape($distroId) + '\}?"?(?:\s|$)' } else { '' }
  $wslTitle = "[WSL: $WslDistro]"
  $found = New-Object System.Collections.Generic.List[object]
  $add = {
    param([string]$method, [IntPtr]$h, [bool]$walked)
    if ($h -eq [IntPtr]::Zero) { return }
    $title = [NotchFocus]::TitleOf($h)
    $owner = $procs[[int][NotchFocus]::OwnerOf($h)]
    $onDistro = $title.IndexOf($wslTitle, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $editorApp = [bool]($owner -and $owner.Name -match '^(code|code - insiders|cursor|windsurf|vscodium)\.exe$')
    # Walking up from VS Code's WSL connection reaches whichever of its windows is on top, maybe
    # another workspace: only use that when nothing better turns up.
    $weak = $walked -and $editorApp -and -not $onDistro
    $known = $found | Where-Object { $_.H -eq $h } | Select-Object -First 1
    if ($known) {
      if (-not $weak) { $known.Weak = $false }
      return
    }
    $found.Add([pscustomobject]@{ Method = $method; H = $h; Title = $title; Editor = ($onDistro -or $editorApp); Weak = $weak })
  }
  foreach ($p in $all) {
    $name = ([string]$p.Name).ToLowerInvariant()
    $cl = [string]$p.CommandLine
    # The notch's own wsl.exe calls (git status, distro list) have no window of their own.
    if ($AppPid -gt 0 -and [int]$p.ParentProcessId -eq $AppPid) { continue }
    $match = $false
    if ($name -eq 'wsl.exe') {
      if ($cl -match 'docker-desktop') { continue }
      if ($cl -match $distroArg -or ($idArg -and $cl -match $idArg)) { $match = $true }
      elseif ($default -eq $WslDistro -and $cl -notmatch '(?i)(?:^|\s)(?:-d|--distribution|--distribution-id)\s') { $match = $true }
    } elseif ($launcher -and $name -eq "$launcher.exe") { $match = $true }
    if (-not $match) { continue }
    $r = Find-HostWindow ([int]$p.ProcessId)
    if ($r) { & $add $r[0] $r[1] ($r[0] -ne 'console') }
  }
  foreach ($h in [NotchFocus]::WindowsTitled($wslTitle)) { & $add 'title' $h $false }
  if ($found.Count -eq 0) { 'notfound'; exit 1 }
  $pool = @($found | Where-Object { -not $_.Weak })
  if ($pool.Count -eq 0) { $pool = @($found) }
  $pick = @($pool | Where-Object { $_.Editor -eq [bool]$VsCode })
  if ($pick.Count -eq 0) { $pick = $pool }
  if ($Folder) {
    $byFolder = @($pick | Where-Object { $_.Title.IndexOf($Folder, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($byFolder.Count -gt 0) { $pick = $byFolder }
  }
  Write-Result "wsl:$($pick[0].Method)" $pick[0].H
}

if ($TargetPid -le 0) { 'notfound'; exit 1 }

$h = [NotchFocus]::ConsoleWindowOf([uint32]$TargetPid)
if ($h -ne [IntPtr]::Zero) { Write-Result 'console' $h }

# Fallback: walk up the process tree.
Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name | ForEach-Object {
  $procs[[int]$_.ProcessId] = @{ Parent = [int]$_.ParentProcessId; Name = ([string]$_.Name).ToLowerInvariant() }
}
$r = Find-HostWindow $TargetPid
if ($r) { Write-Result $r[0] $r[1] }

'notfound'
exit 1
