# Brings the terminal window hosting a Copilot CLI process to the foreground.
# Usage: focus-terminal.ps1 -TargetPid <pid> [-FindOnly]
# Prints "ok <method> <hwnd>" on success ("found <method> <hwnd>" with -FindOnly, which does not
# change focus) or "notfound" and exits 1.
param([Parameter(Mandatory = $true)][int]$TargetPid, [switch]$FindOnly)

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

$h = [NotchFocus]::ConsoleWindowOf([uint32]$TargetPid)
if ($h -ne [IntPtr]::Zero) { Write-Result 'console' $h }

# Fallback: walk up the process tree (Windows Terminal, VS Code, etc. own the visible window).
# Stop at shell/system processes so we never focus an unrelated Explorer window.
$stopAt = @('explorer.exe', 'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'sihost.exe', 'userinit.exe')
$procs = @{}
Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name | ForEach-Object {
  $procs[[int]$_.ProcessId] = @{ Parent = [int]$_.ParentProcessId; Name = ([string]$_.Name).ToLowerInvariant() }
}
$id = $TargetPid
for ($i = 0; $i -lt 12 -and $id -gt 4; $i++) {
  if (-not $procs.ContainsKey($id) -or $stopAt -contains $procs[$id].Name) { break }
  $h = [NotchFocus]::TopWindowOf([uint32]$id)
  if ($h -ne [IntPtr]::Zero) { Write-Result "ancestor:$id" $h }
  $id = $procs[$id].Parent
}

'notfound'
exit 1
