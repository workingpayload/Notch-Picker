'use strict';

// Notch Picker downloads: reports this browser's downloads to the Notch Picker app on this
// computer (http://127.0.0.1 on the ports below) and carries out the pause / resume / cancel
// clicks from the notch. Only file names, paths, sizes and states are sent, never web addresses,
// and nothing leaves the computer. Private-window downloads are never reported.

const api = globalThis.browser || globalThis.chrome;
// Keep in sync with BRIDGE_PORTS in src/download-monitor.js.
const PORTS = [47615, 47616, 47617];
const ACTIVE_MS = 1000; // while something downloads
const RECENT_MS = 60000; // finished downloads are reported for a minute (retry after a failure)
const RECENT_POLL_MS = 3000;
const OFFLINE_RETRY_MS = 5000; // Notch Picker isn't running

let port = null;
let timer = null;
let busy = false;
let again = false;
let offlineUntil = 0;
let sourceId = null;
// Download id -> when it stopped running (null while running).
const tracked = new Map();

function browserName() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Vivaldi\//.test(ua)) return 'Vivaldi';
  if (navigator.brave) return 'Brave';
  return 'Chrome';
}

async function getSourceId() {
  if (sourceId) return sourceId;
  try {
    const stored = await api.storage.local.get('sourceId');
    sourceId = stored && stored.sourceId;
    if (!sourceId) {
      sourceId = crypto.randomUUID();
      await api.storage.local.set({ sourceId });
    }
  } catch {
    sourceId = sourceId || crypto.randomUUID();
  }
  return sourceId;
}

function toItem(d) {
  const path = d.filename || '';
  // Firefox pauses by cancelling and keeping the data: "interrupted" + paused. Report it the way
  // Chrome does (still in progress, paused) so the notch keeps it with a Resume button.
  const ffPaused = d.state === 'interrupted' && d.paused && d.canResume;
  return {
    id: d.id,
    name: path.split(/[\\/]/).pop() || '',
    path,
    state: ffPaused ? 'in_progress' : d.state,
    paused: !!d.paused,
    canResume: !!d.canResume,
    received: d.bytesReceived > 0 ? d.bytesReceived : 0,
    total: d.totalBytes > 0 ? d.totalBytes : d.fileSize > 0 ? d.fileSize : 0,
    eta: d.estimatedEndTime ? Date.parse(d.estimatedEndTime) || 0 : 0,
    endTime: d.endTime ? Date.parse(d.endTime) || 0 : 0,
    error: ffPaused ? '' : d.error || '',
  };
}

async function runningDownloads() {
  const list = await api.downloads.search({ state: 'in_progress' });
  try {
    const paused = await api.downloads.search({ paused: true });
    for (const d of paused) if (!list.some((x) => x.id === d.id)) list.push(d);
  } catch {
    // older browsers: paused downloads are 'in_progress' anyway
  }
  return list.filter((d) => !d.incognito);
}

async function collect() {
  const now = Date.now();
  const running = await runningDownloads();
  const runningIds = new Set(running.map((d) => d.id));
  for (const id of runningIds) tracked.set(id, null);
  for (const [id, stoppedAt] of tracked) {
    if (runningIds.has(id)) continue;
    if (stoppedAt === null) tracked.set(id, now);
    else if (now - stoppedAt > RECENT_MS) tracked.delete(id);
  }
  const items = running.map(toItem);
  for (const id of tracked.keys()) {
    if (runningIds.has(id)) continue;
    const [d] = await api.downloads.search({ id });
    if (d && !d.incognito) items.push(toItem(d));
    else tracked.delete(id);
  }
  return items;
}

async function post(body) {
  const order = port ? [port, ...PORTS.filter((p) => p !== port)] : PORTS;
  for (const p of order) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/notch-picker/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Notch-Picker': '1' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const reply = await res.json();
      if (!reply || reply.app !== 'notch-picker') continue;
      port = p;
      return reply;
    } catch {
      // not listening on this port
    }
  }
  port = null;
  return null;
}

async function runCommands(commands) {
  if (!Array.isArray(commands)) return false;
  let ran = false;
  for (const c of commands) {
    if (!c || !Number.isInteger(c.id)) continue;
    try {
      if (c.action === 'pause') await api.downloads.pause(c.id);
      else if (c.action === 'resume') await api.downloads.resume(c.id);
      else if (c.action === 'cancel') await api.downloads.cancel(c.id);
      else continue;
      tracked.set(c.id, null);
      ran = true;
    } catch {
      // the download already finished or can't do that any more
    }
  }
  return ran;
}

async function tick() {
  timer = null;
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  let items = [];
  let ranCommand = false;
  try {
    items = await collect();
    if (Date.now() >= offlineUntil) {
      const reply = await post({ v: 1, source: await getSourceId(), browser: browserName(), items });
      if (reply) ranCommand = await runCommands(reply.commands);
      else offlineUntil = Date.now() + OFFLINE_RETRY_MS;
    }
  } catch {
    // try again on the next tick
  } finally {
    busy = false;
  }
  // Polling only while something runs or finished lately; a new download wakes us up again.
  if (again || ranCommand) {
    again = false;
    schedule(150);
  } else if (items.some((i) => i.state === 'in_progress')) schedule(ACTIVE_MS);
  else if (tracked.size) schedule(RECENT_POLL_MS);
}

function schedule(ms) {
  if (timer) return;
  timer = setTimeout(tick, ms);
}

// Something changed: report right away (and retry the app even if it looked offline).
function kick() {
  clearTimeout(timer);
  timer = null;
  offlineUntil = 0;
  schedule(100);
}

api.downloads.onCreated.addListener((d) => {
  if (!d.incognito) tracked.set(d.id, null);
  kick();
});
api.downloads.onChanged.addListener(() => kick());
api.downloads.onErased.addListener((id) => {
  tracked.delete(id);
  kick();
});

kick();
