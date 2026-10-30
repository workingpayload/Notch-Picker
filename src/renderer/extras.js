'use strict';

// Island extras in the notch: now playing, quick timer, file shelf and battery banners.
// Loaded before renderer.js; uses its globals (el, extras, features, pushBanner, ...) only when
// called, and renderer.js calls initExtras() once everything is defined.

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: 'M4.5 2.6v10.8L13 8z',
  pause: 'M4 2.5h3v11H4zM9 2.5h3v11H9z',
  previous: 'M3 2.5h2v11H3zM13.5 2.5v11L6 8z',
  next: 'M11 2.5h2v11h-2zM2.5 2.5v11L10 8z',
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

function renderMediaCard(m) {
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
  card.setAttribute('aria-label', `Now playing: ${[m.title, m.artist, m.app].filter(Boolean).join(', ')}${playing ? '' : ' (paused)'}`);
  return card;
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

function renderExtras() {
  const parts = [];
  const m = features.media && extras.media;
  if (m) parts.push(renderMediaCard(m));
  if (features.shelf && (extras.shelf.length || dropping)) parts.push(renderShelf(extras.shelf));
  extrasEl.hidden = !parts.length;
  extrasEl.replaceChildren(...parts);
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
  const t = features.timer && extras.timer;
  if (t && !timerChip.hidden) {
    timerChip.querySelector('.clock').textContent = timerClock(t, now);
    setRing(timerChip.querySelector('.ring'), timerProgress(t, now));
  }
}

// ---- Extras from the main process ----

let lastTrackKey = null;
// The media helper reports what was already playing a moment after start-up: no banner for that.
const extrasLoadedAt = Date.now();

function applyExtras(next) {
  extras = { media: null, timer: null, shelf: [], ...(next || {}) };
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
  renderBar();
  renderExtras();
}

function onExtrasEvent(ev) {
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
