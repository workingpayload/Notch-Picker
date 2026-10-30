# Long-running helper: reports what is playing in Windows' system media session (Spotify, browsers,
# Media Player, ...) and controls it. Prints one JSON line (ASCII only) whenever it changes:
#   {"media":{"app":"Spotify.exe","title":"...","artist":"...","album":"...","status":"playing",
#             "pos":61000,"dur":215000,"at":1730281234567,"prev":true,"next":true,"toggle":true},"art":"data:image/png;base64,..."}
#   {"media":null}                 (nothing is playing)
#   {"unsupported":true}           (this Windows has no media session API; the helper exits)
# "art" is only included when the cover changed (null: no cover). pos/dur/at are milliseconds
# (at = when the app last reported the position, Unix time).
# Reads commands on stdin: "toggle", "next", "prev". EOF means the app went away.
param([int]$IntervalMs = 1000, [int]$ParentPid = 0)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
  $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
  $asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
} catch {
  [Console]::Out.WriteLine('{"unsupported":true}')
  [Console]::Out.Flush()
  exit 0
}

function Await($op, [type]$type, [int]$timeoutMs = 3000) {
  $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait($timeoutMs)) { return $null }
  return $task.Result
}

try {
  $manager = Await ($managerType::RequestAsync()) $managerType 10000
} catch {
  $manager = $null
}
if (-not $manager) {
  [Console]::Out.WriteLine('{"unsupported":true}')
  [Console]::Out.Flush()
  exit 0
}

# JSON with every non-ASCII character escaped, so the console code page can't garble titles.
function ConvertTo-AsciiJson($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 4
  return [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

function Get-Cover($props) {
  if (-not $props.Thumbnail) { return $null }
  try {
    $stream = Await ($props.Thumbnail.OpenReadAsync()) $streamType
    if (-not $stream) { return $null }
    # The stream is often a private class PowerShell can't see the members of: go through its
    # WinRT interfaces with reflection.
    $size = [Windows.Storage.Streams.IRandomAccessStream].GetProperty('Size').GetValue($stream)
    if ($size -gt 1500000) { return $null }
    $net = $asStreamForRead.Invoke($null, @($stream))
    $mem = New-Object System.IO.MemoryStream
    $net.CopyTo($mem)
    $net.Dispose()
    $type = [string][Windows.Storage.Streams.IContentTypeProvider].GetProperty('ContentType').GetValue($stream)
    if ($type -notmatch '^image/(png|jpeg|jpg|gif|bmp|webp)$') { $type = 'image/png' }
    return "data:$type;base64," + [Convert]::ToBase64String($mem.ToArray())
  } catch {
    return $null
  }
}

$statusNames = @{ 0 = 'stopped'; 1 = 'stopped'; 2 = 'changing'; 3 = 'stopped'; 4 = 'playing'; 5 = 'paused' }
$epoch = [DateTimeOffset]::FromUnixTimeMilliseconds(0)
$last = $null
$lastTrack = $null
$coverSent = $false
$coverTries = 0

function Write-Media {
  $session = $null
  try { $session = $manager.GetCurrentSession() } catch { }
  if (-not $session) {
    if ($script:last -ne 'null') {
      [Console]::Out.WriteLine('{"media":null}')
      [Console]::Out.Flush()
      $script:last = 'null'
      $script:lastTrack = $null
    }
    return
  }
  $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
  $info = $session.GetPlaybackInfo()
  $timeline = $session.GetTimelineProperties()
  $status = $statusNames[[int]$info.PlaybackStatus]
  if (-not $status) { $status = 'stopped' }
  $updated = $timeline.LastUpdatedTime
  $media = [ordered]@{
    app    = [string]$session.SourceAppUserModelId
    title  = if ($props) { [string]$props.Title } else { '' }
    artist = if ($props) { [string]$props.Artist } else { '' }
    album  = if ($props) { [string]$props.AlbumTitle } else { '' }
    status = $status
    pos    = [long]$timeline.Position.TotalMilliseconds
    dur    = [long]($timeline.EndTime - $timeline.StartTime).TotalMilliseconds
    at     = if ($updated -gt $epoch) { $updated.ToUnixTimeMilliseconds() } else { 0 }
    prev   = [bool]$info.Controls.IsPreviousEnabled
    next   = [bool]$info.Controls.IsNextEnabled
    toggle = [bool]($info.Controls.IsPlayPauseToggleEnabled -or $info.Controls.IsPlayEnabled -or $info.Controls.IsPauseEnabled)
  }
  $line = ConvertTo-AsciiJson $media
  # The cover is read (and sent) when the track changes, and again while the app hasn't published
  # it yet (browsers set it after downloading the artwork): a few tries per track.
  $track = "$($media.app)|$($media.title)|$($media.artist)|$($media.album)"
  $sendArt = $false
  $cover = $null
  if ($track -cne $script:lastTrack) {
    $script:lastTrack = $track
    $script:coverSent = $false
    $script:coverTries = 0
    $sendArt = $true
  }
  if ($props -and $props.Thumbnail -and -not $script:coverSent -and $script:coverTries -lt 5) {
    $script:coverTries++
    $cover = Get-Cover $props
    if ($cover) {
      $script:coverSent = $true
      $sendArt = $true
    }
  }
  if ($line -ceq $script:last -and -not $sendArt) { return }
  $script:last = $line
  $out = '{"media":' + $line
  if ($sendArt) { $out += ',"art":' + $(if ($cover) { '"' + $cover + '"' } else { 'null' }) }
  [Console]::Out.WriteLine($out + '}')
  [Console]::Out.Flush()
}

function Send-MediaCommand([string]$cmd) {
  $session = $null
  try { $session = $manager.GetCurrentSession() } catch { }
  if (-not $session) { return }
  $op = switch ($cmd) {
    'toggle' { $session.TryTogglePlayPauseAsync() }
    'next' { $session.TrySkipNextAsync() }
    'prev' { $session.TrySkipPreviousAsync() }
  }
  if ($op) { [void](Await $op ([bool])) }
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$tickMs = 100
$elapsed = $IntervalMs
while ($true) {
  if ($pending.IsCompleted) {
    $cmd = $pending.Result
    if ($null -eq $cmd) { exit 0 }
    try { Send-MediaCommand $cmd.Trim() } catch { }
    # Report the new state soon after a command, once the app has reacted.
    $elapsed = $IntervalMs - 250
    $pending = $stdin.ReadLineAsync()
  }
  if ($elapsed -ge $IntervalMs) {
    $elapsed = 0
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
    try { Write-Media } catch { }
  }
  Start-Sleep -Milliseconds $tickMs
  $elapsed += $tickMs
}
