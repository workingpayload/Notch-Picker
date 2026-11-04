'use strict';

// Pure Dynamic Island rules, shared by the main process (require), the notch renderer
// (<script>) and the unit tests: which activity the pill shows, which one pops out into the
// split bubble, and which events grow the pill into a banner.

const ALERT_STATUSES = new Set(['approval', 'input']);

function isActiveSession(s) {
  return !!s && !s.muted && s.status !== 'idle';
}

function isAlerting(s) {
  return !!s && !s.muted && ALERT_STATUSES.has(s.status);
}

// Media counts as a live activity while it plays; paused media stays in the panel only.
function mediaPlaying(media) {
  return !!media && media.status === 'playing' && !!(media.title || media.artist);
}

function timerRunning(timer) {
  return !!timer && (!!timer.runningSince || timer.accumulatedMs > 0);
}

const LIVE_DOWNLOAD_STATES = new Set(['active', 'paused', 'stalled']);

function isLiveDownload(d) {
  return !!d && LIVE_DOWNLOAD_STATES.has(d.state);
}

// The pill's view of the live downloads (null when none): one name or "3 downloads", combined
// bytes, a 0..1 progress when every size is known (else null), speed and time left.
function downloadSummary(list) {
  const live = (list || []).filter(isLiveDownload);
  if (!live.length) return null;
  const received = live.reduce((n, d) => n + (d.received || 0), 0);
  const known = live.every((d) => d.total > 0);
  const total = known ? live.reduce((n, d) => n + d.total, 0) : 0;
  const speed = live.reduce((n, d) => n + (d.speed || 0), 0);
  let etaMs = 0;
  if (known && speed > 0 && total > received) etaMs = Math.round(((total - received) / speed) * 1000);
  else etaMs = live.reduce((n, d) => Math.max(n, d.etaMs || 0), 0);
  return {
    count: live.length,
    name: live.length === 1 ? live[0].name || 'Downloading…' : `${live.length} downloads`,
    key: live[0].key,
    received,
    total,
    progress: known ? Math.min(1, received / total) : null,
    speed,
    etaMs,
    // Every download paused by the user (a stalled one, no data for a while, isn't "paused").
    paused: live.every((d) => d.state === 'paused'),
    browser: live.length === 1 ? live[0].browser || '' : '',
  };
}

// Activities in priority order: sessions (already sorted by urgency, muted last), then a running
// timer, then downloads in progress, then playing media. `pickedId` is a session the user scrolled
// to on the pill; it is shown first unless another session needs attention.
//
// Returns { primary, secondary, more }:
//   primary   - what the pill shows: { kind: 'session' | 'media' | 'timer' | 'download' | 'none', ... }
//   secondary - what the split bubble shows (null when there is only one activity)
//   more      - how many further activities are hidden
function planIsland({ sessions = [], media = null, timer = null, downloads = null, pickedId = null } = {}) {
  const active = sessions.filter(isActiveSession);
  const picked = pickedId ? sessions.find((s) => s.id === pickedId && !s.muted) : null;
  const alerting = active.find(isAlerting);
  let ordered = active;
  if (picked && !(alerting && alerting.id !== picked.id)) ordered = [picked, ...active.filter((s) => s.id !== picked.id)];

  const list = ordered.map((session) => ({ kind: 'session', id: session.id, session }));
  if (timerRunning(timer)) list.push({ kind: 'timer', id: 'timer', timer });
  const download = downloadSummary(downloads);
  if (download) list.push({ kind: 'download', id: 'download', download });
  if (mediaPlaying(media)) list.push({ kind: 'media', id: 'media', media });

  let primary = list[0];
  if (!primary) {
    // Nothing live: the pill shows the most recent (idle) session, or that there are none.
    const top = picked || sessions[0];
    primary = top ? { kind: 'session', id: top.id, session: top } : { kind: 'none', id: 'none' };
  }
  const rest = list.filter((a) => a !== primary);
  return { primary, secondary: rest[0] || null, more: Math.max(0, rest.length - 1) };
}

// The next session to show when cycling the pill with the scroll wheel (direction +1 / -1).
function cycleSession(sessions, currentId, direction) {
  const live = sessions.filter((s) => !s.muted);
  if (live.length < 2) return null;
  const i = live.findIndex((s) => s.id === currentId);
  const next = (Math.max(0, i) + (direction < 0 ? -1 : 1) + live.length) % live.length;
  return live[next].id;
}

const BANNER_MS = { done: 3600, error: 4500, attention: 5000, timer: 6000, battery: 3200, media: 3000, download: 4500 };

// A transition from the session watcher as a banner, or null. `top` is the pill's current top
// session: a finished session doesn't take over while another one needs you.
function bannerForTransition(t, top) {
  if (!t || !t.session) return null;
  const s = t.session;
  if (t.kind === 'done' || t.kind === 'error') {
    if (top && top.id !== s.id && isAlerting(top)) return null;
    return {
      key: `session:${s.id}`,
      kind: t.kind,
      status: t.kind,
      title: t.kind === 'error' ? 'Error' : 'Done',
      subtitle: s.name,
      sessionId: s.id,
      tag: s.tag || null,
      ms: BANNER_MS[t.kind],
    };
  }
  if (t.kind === 'attention') {
    return {
      key: `session:${s.id}`,
      kind: 'attention',
      status: s.status === 'input' ? 'input' : 'approval',
      title: s.label || (s.status === 'input' ? 'Needs your input' : 'Needs approval'),
      subtitle: s.detail ? `${s.name} · ${s.detail}` : s.name,
      sessionId: s.id,
      tag: s.tag || null,
      urgent: true,
      ms: BANNER_MS.attention,
    };
  }
  return null;
}

const LOW_BATTERY_LEVELS = [20, 10, 5];

// Battery banner for a change from `prev` to `next` ({ charging, level: 0..1 }), or null.
// Plugging in shows "Charging"; while discharging, crossing 20%, 10% and 5% warns once each.
function batteryBanner(prev, next) {
  if (!prev || !next || !Number.isFinite(next.level)) return null;
  const pct = Math.round(next.level * 100);
  if (next.charging && !prev.charging) {
    return { key: 'battery', kind: 'battery', status: 'done', title: 'Charging', subtitle: `${pct}%`, level: next.level, charging: true, ms: BANNER_MS.battery };
  }
  if (!next.charging && Number.isFinite(prev.level)) {
    const before = Math.round(prev.level * 100);
    const crossed = LOW_BATTERY_LEVELS.find((l) => before > l && pct <= l);
    if (crossed) {
      return {
        key: 'battery',
        kind: 'battery',
        status: pct <= 10 ? 'error' : 'approval',
        title: 'Low battery',
        subtitle: `${pct}% remaining`,
        level: next.level,
        charging: false,
        urgent: pct <= 10,
        ms: BANNER_MS.battery + 1500,
      };
    }
  }
  return null;
}

// "Spotify.exe", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", "MSEdge", ... -> a name.
const KNOWN_APPS = [
  [/spotify/i, 'Spotify'],
  [/zunemusic|media\s*player/i, 'Media Player'],
  [/zunevideo/i, 'Movies & TV'],
  [/msedge|microsoftedge/i, 'Edge'],
  [/chrome/i, 'Chrome'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox'],
  [/brave/i, 'Brave'],
  [/opera/i, 'Opera'],
  [/vivaldi/i, 'Vivaldi'],
  [/vlc/i, 'VLC'],
  [/applemusic|itunes/i, 'Apple Music'],
  [/tidal/i, 'TIDAL'],
  [/deezer/i, 'Deezer'],
  [/amazon.*music/i, 'Amazon Music'],
  [/youtube/i, 'YouTube Music'],
  [/foobar/i, 'foobar2000'],
  [/musicbee/i, 'MusicBee'],
  [/winamp/i, 'Winamp'],
  [/discord/i, 'Discord'],
];

function prettyAppName(id) {
  if (!id || typeof id !== 'string') return '';
  for (const [re, name] of KNOWN_APPS) if (re.test(id)) return name;
  let name = id.split('!').pop();
  name = name.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (name.includes('.')) name = name.split('.').pop();
  name = name.replace(/_[a-z0-9]{13}$/i, '');
  if (!name || /^[0-9A-F]{8,}$/i.test(name)) return '';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Current playback position (ms), extrapolated from the last report while playing.
function mediaPosition(media, now = Date.now()) {
  if (!media || !Number.isFinite(media.positionMs)) return 0;
  let pos = media.positionMs;
  if (media.status === 'playing' && Number.isFinite(media.updatedAt) && media.updatedAt > 0) pos += Math.max(0, now - media.updatedAt);
  return media.durationMs > 0 ? Math.min(pos, media.durationMs) : pos;
}

// Index of the synced lyric line playing at `posMs` (lines sorted by `t`), or -1 before the first.
function lyricIndexAt(lines, posMs) {
  if (!Array.isArray(lines) || !lines.length || !Number.isFinite(posMs)) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= posMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// Elapsed / remaining time of the quick timer at `now`.
function timerElapsed(timer, now = Date.now()) {
  if (!timer) return 0;
  return Math.max(0, (timer.accumulatedMs || 0) + (timer.runningSince ? now - timer.runningSince : 0));
}

function timerRemaining(timer, now = Date.now()) {
  if (!timer || timer.mode !== 'timer') return 0;
  return Math.max(0, timer.durationMs - timerElapsed(timer, now));
}

// 0..1: how far a countdown has run (stopwatches go round once a minute).
function timerProgress(timer, now = Date.now()) {
  if (!timer) return 0;
  if (timer.mode === 'timer') return timer.durationMs > 0 ? Math.min(1, timerElapsed(timer, now) / timer.durationMs) : 0;
  return (timerElapsed(timer, now) % 60000) / 60000;
}

// 75000 -> "1:15", 3725000 -> "1:02:05"; counts down whole seconds up (5.2 s left shows 0:06).
function formatClock(ms, { roundUp = false } = {}) {
  const total = Math.max(0, roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// 1536 -> "1.5 KB", 12345678 -> "12.3 MB" (decimal units, like browsers' download lists).
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)} KB`;
  return `${Math.round(n)} B`;
}

function formatRate(bytesPerSec) {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : '';
}

// Time left: "8 s left", "3 min left", "1 h 5 min left" ('' when unknown).
function formatEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min left` : `${h} h left`;
}

// Why a download failed, from the browser's interrupt reason ('' when it doesn't say).
function downloadError(code) {
  if (!code) return '';
  if (code === 'FILE_NO_SPACE') return 'Disk is full';
  if (code === 'FILE_ACCESS_DENIED') return 'Access denied';
  if (code === 'FILE_TOO_LARGE') return 'File too large';
  if (code === 'FILE_VIRUS_INFECTED' || code === 'FILE_BLOCKED' || code === 'FILE_SECURITY_CHECK_FAILED') return 'Blocked';
  if (code.startsWith('NETWORK_')) return 'Network error';
  if (code.startsWith('SERVER_')) return 'Server error';
  if (code.startsWith('FILE_')) return 'File error';
  return '';
}

// A finished or failed download ({ key, name, browser, ok, error, openable }) as a banner.
function downloadBanner(ev) {
  if (!ev || !ev.key) return null;
  const name = ev.name || 'Download';
  if (ev.ok) {
    return {
      key: `download:${ev.key}`,
      kind: 'download',
      status: 'done',
      title: 'Downloaded',
      subtitle: ev.browser ? `${name} · ${ev.browser}` : name,
      downloadKey: ev.key,
      openable: ev.openable !== false,
      ms: BANNER_MS.download,
    };
  }
  const why = downloadError(ev.error);
  return {
    key: `download:${ev.key}`,
    kind: 'download',
    status: 'error',
    title: 'Download failed',
    subtitle: why ? `${name} · ${why}` : name,
    downloadKey: ev.key,
    ms: BANNER_MS.error,
  };
}

{
  const api = {
    planIsland,
    cycleSession,
    bannerForTransition,
    batteryBanner,
    prettyAppName,
    mediaPlaying,
    mediaPosition,
    lyricIndexAt,
    timerRunning,
    timerElapsed,
    timerRemaining,
    timerProgress,
    formatClock,
    isLiveDownload,
    downloadSummary,
    downloadBanner,
    downloadError,
    formatBytes,
    formatRate,
    formatEta,
    isAlerting,
    BANNER_MS,
  };
  // Shared by the main process and tests (require) and the sandboxed notch renderer (<script>).
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.NotchIsland = api;
}
