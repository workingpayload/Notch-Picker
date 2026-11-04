'use strict';

// Island extras in the notch: now playing, quick timer, file shelf, downloads and battery banners.
// Loaded before renderer.js; uses its globals (el, extras, features, pushBanner, ...) only when
// called, and renderer.js calls initExtras() once everything is defined.

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: 'M4.5 2.6v10.8L13 8z',
  pause: 'M4 2.5h3v11H4zM9 2.5h3v11H9z',
  previous: 'M3 2.5h2v11H3zM13.5 2.5v11L6 8z',
  next: 'M11 2.5h2v11h-2zM2.5 2.5v11L10 8z',
  folder: 'M1.5 3h5l1.5 1.6h6.5v8.4h-13z',
  close: 'M3.6 2.5 8 6.9l4.4-4.4 1.1 1.1L9.1 8l4.4 4.4-1.1 1.1L8 9.1l-4.4 4.4-1.1-1.1L6.9 8 2.5 3.6z',
  retry: 'M8 2.5a5.5 5.5 0 1 0 5.4 6.5h-1.7A3.9 3.9 0 1 1 8 4.1c1 0 1.9.4 2.6 1L8.5 7.2H14V1.7l-2.2 2.2A5.5 5.5 0 0 0 8 2.5z',
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// Outline stopwatch in the text colour; the ⏱ emoji sits above the text baseline.
function stopwatchIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('stopwatch');
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '9.25');
  circle.setAttribute('r', '5.25');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 9.25V6.5M6.25 1.75h3.5M8 1.75V4M12.1 4.9l1.15-1.15');
  svg.append(circle, path);
  return svg;
}

function iconButton(name, label, onClick, { disabled = false, cls = '' } = {}) {
  const b = el('button', `icon-btn ${cls}`.trim());
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  b.append(icon(name));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function renderMediaCard(m, lyricsBox = null) {
  const card = el('div', `media-card${m.status === 'playing' ? ' playing' : ''}`);
  setStatusClass(card, 'media');
  if (m.art) {
    const cover = el('img', 'cover');
    cover.src = m.art;
    cover.alt = '';
    cover.draggable = false;
    card.append(cover);
  } else card.append(el('span', 'cover none', '♪'));

  const info = el('div', 'media-info');
  const title = el('b', 'media-title', m.title || m.artist || 'Unknown');
  title.title = m.title;
  const sub = el('span', 'media-sub', [m.title ? m.artist : '', m.app].filter(Boolean).join(' · '));
  sub.title = [m.artist, m.album, m.app].filter(Boolean).join(' · ');
  info.append(title, sub);
  if (m.durationMs > 0) {
    const progress = el('div', 'media-progress');
    const meter = el('i', 'meter');
    meter.append(el('b'));
    progress.append(el('span', 'pos'), meter, el('span', 'dur', window.NotchIsland.formatClock(m.durationMs)));
    info.append(progress);
  }
  const controls = el('div', 'media-controls');
  const playing = m.status === 'playing';
  controls.append(
    iconButton('previous', 'Previous', () => window.notchApi.mediaCommand('previous'), { disabled: !m.canPrevious }),
    iconButton(playing ? 'pause' : 'play', playing ? 'Pause' : 'Play', () => window.notchApi.mediaCommand('toggle'), {
      disabled: !m.canToggle,
      cls: 'main',
    }),
    iconButton('next', 'Next', () => window.notchApi.mediaCommand('next'), { disabled: !m.canNext })
  );
  card.append(info, controls);
  if (lyricsBox) {
    card.classList.add('has-lyrics');
    card.append(lyricsBox);
  }
  card.setAttribute('aria-label', `Now playing: ${[m.title, m.artist, m.app].filter(Boolean).join(', ')}${playing ? '' : ' (paused)'}`);
  return card;
}

// ---- Lyrics (Settings → Dynamic Island → Lyrics) ----
// Synced lyrics scroll in a three-line strip under the media card's controls; the lines are drawn
// once per track and the highlight follows the playback position. Unsynced lyrics are a static
// list to scroll. With "Lyrics in the pill" the current line also replaces the title in the pill.

// Lines feel late when they appear exactly on time.
const LYRICS_LEAD_MS = 200;
let lyricsInPill = false;
let lyricsOffsetMs = 0;
const lyricsView = { key: null, node: null, track: null, index: null, scroll: 0 };

function currentLyrics() {
  const l = features.media && extras.media && extras.lyrics;
  return l && l.status === 'found' ? l : null;
}

function lyricsPosition(now) {
  return window.NotchIsland.mediaPosition(extras.media, now) + LYRICS_LEAD_MS + lyricsOffsetMs;
}

function buildLyrics(l) {
  const box = el('div', `lyrics ${l.instrumental ? 'instrumental' : l.synced ? 'synced' : 'plain'}`);
  if (l.instrumental) {
    box.append(el('p', 'current', '♪  Instrumental  ♪'));
    return box;
  }
  const track = el('div', 'lyrics-track');
  for (const line of l.lines) track.append(el('p', line.text ? '' : 'gap', line.text || '♪'));
  box.append(track);
  if (l.synced) {
    // Screen readers would announce every line change; the title is in the card's label already.
    box.setAttribute('aria-hidden', 'true');
  } else {
    box.tabIndex = 0;
    box.setAttribute('aria-label', 'Lyrics');
    box.addEventListener('scroll', () => (lyricsView.scroll = box.scrollTop));
  }
  return box;
}

// The lyrics element for the current track (kept across media card rebuilds), or null.
function lyricsNode() {
  const l = currentLyrics();
  const key = l ? `${l.key}|${l.synced}|${l.instrumental}|${l.lines.length}` : null;
  if (key !== lyricsView.key) {
    lyricsView.key = key;
    lyricsView.node = l ? buildLyrics(l) : null;
    lyricsView.track = lyricsView.node && lyricsView.node.querySelector('.lyrics-track');
    lyricsView.index = null;
    lyricsView.scroll = 0;
  }
  return lyricsView.node;
}

// Highlights the current line and centres it in the strip.
function updateLyricsStrip(now) {
  const l = currentLyrics();
  const node = lyricsView.node;
  if (!l || !l.synced || !node || !node.isConnected || !lyricsView.track) return;
  node.classList.toggle('paused', extras.media.status !== 'playing');
  if (!node.clientHeight) return;
  const rows = lyricsView.track.children;
  const i = window.NotchIsland.lyricIndexAt(l.lines, lyricsPosition(now));
  if (i !== lyricsView.index) {
    if (lyricsView.index !== null && lyricsView.index >= 0 && rows[lyricsView.index]) rows[lyricsView.index].classList.remove('current');
    if (i >= 0) rows[i].classList.add('current');
    lyricsView.index = i;
  }
  const row = rows[Math.max(0, i)];
  const offset = Math.max(0, row.offsetTop + row.offsetHeight / 2 - node.clientHeight / 2);
  const transform = `translateY(${-Math.round(offset)}px)`;
  if (lyricsView.track.style.transform !== transform) lyricsView.track.style.transform = transform;
}

// The line for the pill while synced lyrics play (null: show the title as usual).
function pillLyric(now) {
  const l = lyricsInPill && currentLyrics();
  if (!l || !l.synced || extras.media.status !== 'playing') return null;
  const i = window.NotchIsland.lyricIndexAt(l.lines, lyricsPosition(now));
  return i >= 0 ? l.lines[i].text || '♪' : null;
}

// The running timer as a chip in the panel header (the ⏱ button next to it opens the menu).
function renderTimerChip(t) {
  timerChip.hidden = !t;
  if (!t) return;
  const running = !!t.runningSince;
  setStatusClass(timerChip, 'timer');
  timerChip.classList.toggle('paused', !running);
  const what = t.mode === 'timer' ? `${describeMinutes(t.durationMs)} timer` : 'Stopwatch';
  timerChip.title = `${what}${running ? '' : ' (paused)'} — click to ${running ? 'pause' : 'resume'}, right-click for more`;
  timerChip.setAttribute('aria-label', timerChip.title);
}

function describeMinutes(ms) {
  const min = Math.round(ms / 60000);
  if (min >= 60 && min % 60 === 0) return `${min / 60} h`;
  return min >= 1 ? `${min} min` : `${Math.round(ms / 1000)} s`;
}

function fileGlyph(item) {
  if (item.icon) {
    const img = el('img', 'file-icon');
    img.src = item.icon;
    img.alt = '';
    img.draggable = false;
    return img;
  }
  return el('span', 'file-icon none', item.dir ? '📁' : '📄');
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

function renderShelf(items) {
  const shelf = el('div', `shelf${dropping ? ' dropping' : ''}`);
  const head = el('div', 'shelf-head');
  head.append(el('span', null, items.length ? `Shelf · ${items.length}` : 'Shelf'));
  if (items.length) {
    const clear = el('button', 'link-btn', 'Clear');
    clear.type = 'button';
    clear.title = 'Remove everything from the shelf (the files stay where they are)';
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      window.notchApi.shelfClear();
    });
    head.append(clear);
  }
  shelf.append(head);
  if (items.length) {
    const list = el('div', 'shelf-items');
    list.setAttribute('role', 'list');
    for (const item of items) {
      const chip = el('div', 'shelf-item');
      chip.draggable = true;
      chip.tabIndex = 0;
      chip.setAttribute('role', 'listitem');
      chip.title = `${item.path}${item.size ? `\n${formatSize(item.size)}` : ''}\nClick to open · drag into any app · right-click for more`;
      chip.setAttribute('aria-label', `${item.name}. Enter to open, Shift+F10 for options.`);
      chip.append(fileGlyph(item), el('span', 'name', item.name));
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        window.notchApi.shelfOpen(item.path);
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') window.notchApi.shelfOpen(item.path);
        else if (e.key === 'Delete') window.notchApi.shelfRemove(item.path);
        else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          window.notchApi.shelfMenu(item.path);
        }
      });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.notchApi.shelfMenu(item.path);
      });
      // The main process starts a real file drag, so the file can be dropped into other apps.
      chip.addEventListener('dragstart', (e) => {
        e.preventDefault();
        window.notchApi.shelfDrag(item.path);
      });
      list.append(chip);
    }
    shelf.append(list);
  }
  if (dropping || !items.length) {
    shelf.append(el('div', 'drop-zone', dropping ? 'Drop to keep it on the shelf' : 'Drop files on the notch to keep them here'));
  }
  return shelf;
}

// ---- Downloads: one row per download, updated in place (updates arrive every second, and
// rebuilding the rows would swallow clicks on their buttons) ----

let downloadsUi = null; // built on first use: el() comes from renderer.js, which loads after this file
const downloadRows = new Map(); // key -> { el, icon, name, fill, sub, actions, actionsKey, d }

function downloadsSection() {
  if (downloadsUi) return downloadsUi;
  const root = el('div', 'downloads');
  const head = el('div', 'dl-head');
  const title = el('span');
  const clear = el('button', 'link-btn', 'Clear');
  const list = el('div', 'dl-items');
  clear.type = 'button';
  clear.title = 'Remove finished downloads from the list (the files stay)';
  clear.addEventListener('click', (e) => {
    e.stopPropagation();
    window.notchApi.downloadAction('*', 'clear');
  });
  head.append(title, clear);
  list.setAttribute('role', 'list');
  root.append(head, list);
  downloadsUi = { root, title, clear, list };
  return downloadsUi;
}

const DOWNLOAD_STATUS = { active: 'download', stalled: 'download', paused: 'timer', done: 'done', failed: 'error' };

function downloadDetail(d) {
  const { formatBytes, formatRate, formatEta, downloadError } = window.NotchIsland;
  if (d.state === 'done') return ['Done', d.browser].filter(Boolean).join(' · ');
  if (d.state === 'failed') return ['Failed', downloadError(d.error), d.browser].filter(Boolean).join(' · ');
  const size = d.total ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
  const rate = d.state === 'paused' ? 'Paused' : d.state === 'stalled' ? 'Waiting…' : [formatRate(d.speed), formatEta(d.etaMs)].filter(Boolean).join(' · ');
  return [size, rate, d.browser].filter(Boolean).join(' · ');
}

function downloadButton(row, name, label, action) {
  return iconButton(name, label, () => window.notchApi.downloadAction(row.d.key, action), { cls: 'small' });
}

function downloadRow(d) {
  let row = downloadRows.get(d.key);
  if (!row) {
    row = { el: el('div', 'dl-item'), icon: el('span', 'dl-icon'), name: el('b', 'dl-name'), meter: el('i', 'meter'), fill: el('b'), sub: el('span', 'dl-sub'), actions: el('div', 'dl-actions'), actionsKey: null };
    const info = el('div', 'dl-info');
    row.meter.append(row.fill);
    info.append(row.name, row.meter, row.sub);
    row.el.append(row.icon, info, row.actions);
    row.el.tabIndex = 0;
    row.el.setAttribute('role', 'listitem');
    // Click: open a finished file (documents, media, archives; anything else is shown in its
    // folder), or show a running download in its folder.
    const activate = () => window.notchApi.downloadAction(row.d.key, row.d.state === 'done' ? 'open' : 'show');
    row.el.addEventListener('click', (e) => {
      e.stopPropagation();
      activate();
    });
    row.el.addEventListener('keydown', (e) => {
      if (e.target !== row.el) return;
      if (e.key === 'Enter') activate();
      else if (e.key === 'Delete' && (row.d.state === 'done' || row.d.state === 'failed')) window.notchApi.downloadAction(row.d.key, 'dismiss');
    });
    downloadRows.set(d.key, row);
  }
  row.d = d;
  setStatusClass(row.el, DOWNLOAD_STATUS[d.state] || 'download');
  row.el.dataset.state = d.state;
  if (row.iconState !== d.state) {
    row.iconState = d.state;
    if (d.state === 'paused') row.icon.replaceChildren(icon('pause'));
    else row.icon.textContent = d.state === 'done' ? '✓' : d.state === 'failed' ? '✕' : '↓';
  }
  const name = d.name || 'Downloading…';
  if (row.name.textContent !== name) row.name.textContent = name;
  const live = window.NotchIsland.isLiveDownload(d);
  row.meter.hidden = !live;
  row.meter.classList.toggle('indeterminate', live && !(d.total > 0));
  row.fill.style.width = d.total > 0 ? `${Math.min(100, (d.received / d.total) * 100)}%` : '';
  const detail = downloadDetail(d);
  if (row.sub.textContent !== detail) row.sub.textContent = detail;
  row.el.title = `${d.path || name}\n${d.state === 'done' ? 'Click to open' : 'Click to show in folder'}`;
  row.el.setAttribute('aria-label', `${name}. ${detail}.`);

  const actionsKey = [d.canPause, d.canResume, d.canCancel, d.state].join('|');
  if (row.actionsKey !== actionsKey) {
    row.actionsKey = actionsKey;
    const buttons = [];
    if (d.canPause) buttons.push(downloadButton(row, 'pause', 'Pause', 'pause'));
    if (d.canResume) buttons.push(downloadButton(row, d.state === 'failed' ? 'retry' : 'play', d.state === 'failed' ? 'Retry' : 'Resume', 'resume'));
    if (d.canCancel) buttons.push(downloadButton(row, 'close', 'Cancel download', 'cancel'));
    if (d.state === 'done' || d.state === 'failed') buttons.push(downloadButton(row, 'close', 'Remove from list', 'dismiss'));
    else buttons.push(downloadButton(row, 'folder', 'Show in folder', 'show'));
    row.actions.replaceChildren(...buttons);
  }
  return row.el;
}

function updateDownloads(list) {
  const ui = downloadsSection();
  const keys = new Set(list.map((d) => d.key));
  for (const key of downloadRows.keys()) if (!keys.has(key)) downloadRows.delete(key);
  const rows = list.map(downloadRow);
  const current = [...ui.list.children];
  if (current.length !== rows.length || current.some((n, i) => n !== rows[i])) ui.list.replaceChildren(...rows);
  const live = list.filter(window.NotchIsland.isLiveDownload).length;
  ui.title.textContent = live ? `Downloading · ${live}` : 'Downloads';
  ui.clear.hidden = live === list.length;
  return ui.root;
}

// Cards are rebuilt only when what they show changes, so their buttons keep working while
// other extras (download progress) update every second.
const mediaCache = { key: null, node: null };
const shelfCache = { key: null, node: null };

function cached(cache, key, build) {
  if (cache.key !== key) {
    cache.key = key;
    cache.node = build();
  }
  return cache.node;
}

function renderExtras() {
  const parts = [];
  const m = features.media && extras.media;
  if (m) {
    const art = m.art ? `${m.art.length}:${m.art.slice(-40)}` : '';
    // The position moves on its own (liveTickExtras): a new report doesn't need a new card.
    const { positionMs, updatedAt, ...shown } = m;
    const lyricsBox = lyricsNode();
    parts.push(cached(mediaCache, JSON.stringify({ ...shown, art, lyrics: lyricsView.key }), () => renderMediaCard(m, lyricsBox)));
  }
  const dl = features.downloads ? extras.downloads : [];
  if (dl.length) parts.push(updateDownloads(dl));
  else downloadRows.clear();
  if (features.shelf && (extras.shelf.length || dropping)) {
    const key = JSON.stringify([dropping, extras.shelf.map((i) => [i.path, i.name, i.size, i.dir, i.icon ? i.icon.length : 0])]);
    parts.push(cached(shelfCache, key, () => renderShelf(extras.shelf)));
  }
  extrasEl.hidden = !parts.length;
  const current = [...extrasEl.children];
  if (current.length !== parts.length || current.some((n, i) => n !== parts[i])) {
    extrasEl.replaceChildren(...parts);
    // Moving the lyrics into a rebuilt card loses where they were scrolled to.
    const box = lyricsView.node;
    if (box && box.isConnected && box.scrollTop !== lyricsView.scroll) box.scrollTop = lyricsView.scroll;
  }
  timerButton.hidden = !features.timer;
  renderTimerChip(features.timer ? extras.timer : null);
  liveTickExtras(Date.now());
  fitCards();
  if (expanded) resize();
}

// The cards list scrolls; keep the whole panel (header, extras, cards) within the notch window.
function fitCards() {
  const header = notch.querySelector('.panel-header');
  const used = BAR_HEIGHT + header.offsetHeight + (extrasEl.hidden ? 0 : extrasEl.offsetHeight + 8) + 12;
  cards.style.maxHeight = `${Math.max(90, MAX_HEIGHT - used)}px`;
}

function liveTickExtras(now) {
  const { mediaPosition, formatClock, timerProgress } = window.NotchIsland;
  const m = features.media && extras.media;
  const progress = m && extrasEl.querySelector('.media-progress');
  if (progress) {
    const pos = mediaPosition(m, now);
    progress.querySelector('.pos').textContent = formatClock(pos);
    progress.querySelector('.meter b').style.width = `${Math.min(100, (pos / m.durationMs) * 100)}%`;
  }
  if (m) updateLyricsStrip(now);
  const t = features.timer && extras.timer;
  if (t && !timerChip.hidden) {
    timerChip.querySelector('.clock').textContent = timerClock(t, now);
    setRing(timerChip.querySelector('.ring'), timerProgress(t, now));
  }
}

// ---- Extras from the main process ----

// Now-playing colours from the album cover (Settings → Dynamic Island → Album colours): the cover
// is sampled on a tiny canvas and its colours replace the default pink wherever media shows.
let artColorsOn = true;
let artColorsFor = null;
const artCanvas = document.createElement('canvas');
artCanvas.width = artCanvas.height = 24;
const ART_VARS = { dark: '--art-dark', dark2: '--art2-dark', light: '--art-light', light2: '--art2-light' };

function setArtColors(palette) {
  const style = document.documentElement.style;
  for (const [key, name] of Object.entries(ART_VARS)) {
    if (palette) style.setProperty(name, palette[key]);
    else style.removeProperty(name);
  }
}

function applyArtColors() {
  const m = features.media && artColorsOn ? extras.media : null;
  const art = (m && m.art) || null;
  if (art === artColorsFor) return;
  artColorsFor = art;
  if (!art) {
    setArtColors(null);
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (artColorsFor !== art) return;
    const ctx = artCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, artCanvas.width, artCanvas.height);
    ctx.drawImage(img, 0, 0, artCanvas.width, artCanvas.height);
    setArtColors(window.ArtColors.artPalette(ctx.getImageData(0, 0, artCanvas.width, artCanvas.height).data));
  };
  img.onerror = () => {
    if (artColorsFor === art) setArtColors(null);
  };
  img.src = art;
}

let lastTrackKey = null;
// The media helper reports what was already playing a moment after start-up: no banner for that.
const extrasLoadedAt = Date.now();

function applyExtras(next) {
  extras = { media: null, lyrics: null, timer: null, shelf: [], downloads: [], ...(next || {}) };
  const m = extras.media;
  // A new track while playing gets a short "now playing" banner.
  if (m && m.status === 'playing') {
    const key = `${m.appId}|${m.title}|${m.artist}`;
    if (lastTrackKey !== null && key !== lastTrackKey && features.media && Date.now() - extrasLoadedAt > 6000) {
      pushBanner({
        key: 'media',
        kind: 'media',
        status: 'media',
        title: m.title || m.artist,
        subtitle: [m.title ? m.artist : '', m.app].filter(Boolean).join(' · '),
        art: m.art,
        ms: window.NotchIsland.BANNER_MS.media,
      });
    }
    lastTrackKey = key;
  } else if (lastTrackKey === null) lastTrackKey = '';
  applyArtColors();
  renderBar();
  renderExtras();
}

function onExtrasEvent(ev) {
  if (ev && ev.kind === 'download') {
    if (!features.downloads) return;
    const b = window.NotchIsland.downloadBanner(ev);
    if (!b) return;
    pushBanner(b);
    if (!cardBanners()) flash(ev.ok ? 'done' : 'error');
    announce(`${b.title}: ${b.subtitle}`, !ev.ok);
    return;
  }
  if (!ev || ev.kind !== 'timer-done') return;
  const title = ev.mode === 'timer' ? 'Timer finished' : 'Stopwatch stopped';
  pushBanner({
    key: 'timer',
    kind: 'timer',
    status: 'timer',
    title,
    subtitle: ev.mode === 'timer' ? `${describeMinutes(ev.durationMs)} is up` : 'Reached 24 hours',
    urgent: true,
    ms: window.NotchIsland.BANNER_MS.timer,
  });
  flash('done');
  announce(title, true);
}

// ---- File shelf: drop files anywhere on the notch ----

let dragDepth = 0;
let dropTimer = null;

function hasFiles(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

function startDrop() {
  if (dropping) return;
  dropping = true;
  notch.classList.add('dropping');
  expand();
  renderBar();
  renderExtras();
}

function endDrop() {
  clearTimeout(dropTimer);
  dragDepth = 0;
  if (!dropping) return;
  dropping = false;
  notch.classList.remove('dropping');
  renderBar();
  renderExtras();
  if (!hovering) collapse();
}

function onDragEnter(e) {
  if (!features.shelf || !hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  startDrop();
}

function onDragOver(e) {
  if (!dropping) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  // dragover repeats while the drag is over the notch; if it stops, the drag went elsewhere.
  clearTimeout(dropTimer);
  dropTimer = setTimeout(endDrop, 1200);
}

function onDragLeave() {
  if (!dropping) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) endDrop();
}

function onDrop(e) {
  if (!dropping) return;
  e.preventDefault();
  const paths = Array.from(e.dataTransfer.files || [], (f) => window.notchApi.pathForFile(f)).filter(Boolean);
  if (paths.length) {
    window.notchApi.shelfAdd(paths);
    squish(0.7);
    announce(`${paths.length} item${paths.length === 1 ? '' : 's'} added to the shelf`, false);
  }
  endDrop();
}

// ---- Battery: banner when charging starts and when it runs low ----

async function watchBattery() {
  if (!navigator.getBattery) return;
  try {
    const battery = await navigator.getBattery();
    const read = () => ({ charging: battery.charging, level: battery.level });
    let last = read();
    const onChange = () => {
      const next = read();
      const b = features.battery ? window.NotchIsland.batteryBanner(last, next) : null;
      last = next;
      if (!b) return;
      pushBanner(b);
      if (!cardBanners()) flash(b.status === 'done' ? 'done' : 'error');
      announce(`${b.title}, ${b.subtitle}`, !!b.urgent);
    };
    battery.addEventListener('chargingchange', onChange);
    battery.addEventListener('levelchange', onChange);
  } catch {
    // no battery information: nothing to show
  }
}

function initExtras() {
  window.notchApi.onExtras(applyExtras);
  window.notchApi.getExtras().then(applyExtras);
  window.notchApi.onExtrasEvent(onExtrasEvent);
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  watchBattery();
}
