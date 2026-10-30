'use strict';

const BAR_HEIGHT = 24;
const MAX_HEIGHT = 340;
const EMPTY_WIDTH = 170;
const COLLAPSED_WIDTH = 260;
const EXPANDED_WIDTH = 380;
const COLLAPSE_DELAY_MS = 220;
// Dynamic Island: compact pill, banner card, concave shoulders and the split bubble.
const ISLAND_WIDTH = 236;
const BANNER_WIDTH = 330;
const BANNER_HEIGHT = 58;
const SHOULDER = 8;
const BUBBLE_SHOULDER = 6;
const BUBBLE_WIDTH = 28;
const PICK_RESET_MS = 15000;
const LONG_PRESS_MS = 500;
const CODE_STATUSES = new Set(['approval', 'tool']);
const STATUS_CLASSES = ['idle', 'done', 'thinking', 'tool', 'agents', 'approval', 'input', 'error', 'stuck', 'media', 'timer'].map((s) => `status-${s}`);

const island = document.getElementById('island');
const notch = document.getElementById('notch');
const bar = {
  tag: notch.querySelector('.bar .bar-tag'),
  art: notch.querySelector('.bar .art'),
  label: notch.querySelector('.bar .label'),
  detail: notch.querySelector('.bar .detail'),
  wave: notch.querySelector('.bar .wave'),
  ring: notch.querySelector('.bar .ring'),
  elapsed: notch.querySelector('.bar .elapsed'),
  dots: notch.querySelector('.bar .dots'),
};
const bannerEl = notch.querySelector('.banner');
const bannerParts = {
  icon: bannerEl.querySelector('.banner-icon'),
  title: bannerEl.querySelector('.banner-title'),
  sub: bannerEl.querySelector('.banner-sub'),
  side: bannerEl.querySelector('.banner-side'),
};
const bubbleEl = island.querySelector('.bubble');
const bubbleBody = bubbleEl.querySelector('.bubble-body');
const panel = notch.querySelector('.panel');
const extrasEl = notch.querySelector('.extras');
const cards = notch.querySelector('.cards');
const countEl = notch.querySelector('.panel-header .title');
const quotaEl = notch.querySelector('.panel-header .quota');
const timerButton = notch.querySelector('.panel-header .timer-btn');
const timerChip = notch.querySelector('.panel-header .timer-chip');
const pinButton = notch.querySelector('.panel-header .pin');
const DOT_WIDTH = 40;
const SIZE_ZOOM = { tiny: 0.85, small: 1, normal: 1.2 };
let zoom = 1;

let sessions = [];
let ended = [];
const openSections = new Map();
let expanded = false;
let hovering = false;
let pinned = false;
let compact = false;
let align = 'center';
// The coding agent whose sessions are shown (Settings → Agent). agentInfo() comes from ../agents.js.
let agent = 'copilot';
let collapseTimer = null;
let flashTimer = null;
// Island settings and extras (now playing, quick timer, file shelf) from the main process.
let islandStyle = true;
let bannersOn = true;
let expandOn = 'hover';
const features = { media: true, shelf: true, battery: true, timer: true };
let extras = { media: null, timer: null, shelf: [] };
// What the pill and bubble show (NotchIsland.planIsland); a session scrolled to on the pill.
let plan = { primary: { kind: 'none', id: 'none' }, secondary: null, more: 0 };
let pickedId = null;
let pickTimer = null;
// After a swipe up or a banner click the pointer is still over the notch: don't re-open on hover.
let hoverSuppressed = false;
let dropping = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function visualStatus(s) {
  if (s.stuck === 'tool') return 'stuck';
  return s.status === 'idle' && s.label === 'Done' ? 'done' : s.status;
}

function displayLabel(s) {
  return s.stuck === 'tool' ? `Stuck? ${s.label}` : s.label;
}

function setStatusClass(node, status) {
  node.classList.remove(...STATUS_CLASSES);
  node.classList.add(`status-${status}`);
}

function formatElapsed(since) {
  if (!since) return '';
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${String(secs % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  // Linux paths (WSL sessions) keep their slashes.
  const sep = String(p).startsWith('/') ? '/' : '\\';
  return parts.length <= 2 ? p : `…${sep}${parts.slice(-2).join(sep)}`;
}

// Banners are cards in Dynamic Island style; otherwise (or with banners off) they are the old
// text toast in the pill.
function cardBanners() {
  return islandStyle && bannersOn;
}

function bannerShown() {
  return !!banner && cardBanners() && !expanded && !dropping;
}

function setElapsed(since) {
  bar.elapsed.dataset.since = since || '';
  bar.elapsed.textContent = formatElapsed(since);
  delete bar.elapsed.dataset.clock;
}

function setRing(svg, progress) {
  const fill = svg.querySelector('.fill');
  if (fill) fill.style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, progress)) * 100);
}

function makeRing(cls = 'ring') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 16 16');
  for (const part of ['track', 'fill']) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('class', part);
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', '6.5');
    if (part === 'fill') c.setAttribute('pathLength', '100');
    svg.append(c);
  }
  return svg;
}

function makeWave(playing = true) {
  const wave = el('span', `wave${playing ? '' : ' paused'}`);
  for (let i = 0; i < 5; i++) wave.append(el('i'));
  return wave;
}

function setArt(img, src) {
  if (!src) {
    img.hidden = true;
    img.removeAttribute('src');
    return;
  }
  if (img.getAttribute('src') !== src) img.src = src;
  img.hidden = false;
}

function timerClock(t, now = Date.now()) {
  const { formatClock, timerRemaining, timerElapsed } = window.NotchIsland;
  return t.mode === 'timer' ? formatClock(timerRemaining(t, now), { roundUp: true }) : formatClock(timerElapsed(t, now));
}

function renderBar() {
  plan = window.NotchIsland.planIsland({
    sessions,
    media: features.media ? extras.media : null,
    timer: features.timer ? extras.timer : null,
    pickedId,
  });
  const primary = plan.primary;
  const top = primary.kind === 'session' ? primary.session : null;
  const busy = primary.kind === 'media' || primary.kind === 'timer';
  const textBanner = banner && !cardBanners() ? banner : null;
  notch.classList.toggle('empty', primary.kind === 'none' && !banner);
  notch.classList.toggle('dot-only', window.NotchVisibility.isDotOnly({ compact, top, toast: banner, busy }));
  notch.classList.toggle('bannered', bannerShown());
  notch.classList.toggle('text-banner', !!textBanner);
  notch.classList.remove('has-art');
  bar.wave.hidden = true;
  bar.wave.classList.remove('paused');
  bar.ring.toggleAttribute('hidden', true);
  bar.label.title = '';
  setArt(bar.art, null);

  if (textBanner) {
    setStatusClass(notch, textBanner.status);
    notch.classList.remove('attention', 'overdue');
    bar.label.textContent = textBanner.title;
    bar.detail.textContent = textBanner.subtitle;
    setElapsed(null);
  } else if (primary.kind === 'media') {
    const m = primary.media;
    setStatusClass(notch, 'media');
    notch.classList.remove('attention', 'overdue');
    if (islandStyle && m.art) {
      setArt(bar.art, m.art);
      notch.classList.add('has-art');
    }
    bar.label.textContent = islandStyle ? m.title || m.artist : 'Now playing';
    bar.detail.textContent = islandStyle ? m.artist : [m.title, m.artist].filter(Boolean).join(' — ');
    bar.label.title = [m.title, m.artist, m.app].filter(Boolean).join(' · ');
    setElapsed(null);
    bar.wave.hidden = false;
  } else if (primary.kind === 'timer') {
    const t = primary.timer;
    setStatusClass(notch, 'timer');
    notch.classList.remove('attention', 'overdue');
    bar.label.textContent = t.mode === 'timer' ? 'Timer' : 'Stopwatch';
    bar.detail.textContent = t.runningSince ? '' : 'Paused';
    setElapsed(null);
    bar.elapsed.dataset.clock = 'timer';
    bar.elapsed.textContent = timerClock(t);
    if (islandStyle) {
      bar.ring.toggleAttribute('hidden', false);
      setRing(bar.ring, window.NotchIsland.timerProgress(t));
    }
  } else if (!top) {
    setStatusClass(notch, 'idle');
    notch.classList.remove('attention', 'overdue');
    bar.label.textContent = agentInfo(agent).label;
    bar.detail.textContent = 'no live sessions';
    setElapsed(null);
  } else {
    const vs = visualStatus(top);
    setStatusClass(notch, vs);
    const alerting = (vs === 'approval' || vs === 'input') && !top.muted;
    notch.classList.toggle('attention', alerting);
    notch.classList.toggle('overdue', alerting && top.stuck === 'waiting');
    bar.label.textContent = displayLabel(top);
    bar.label.title = islandStyle ? `${top.name}${top.detail ? ` — ${top.detail}` : ''}` : '';
    bar.detail.textContent = top.detail || top.name;
    setElapsed(top.status === 'idle' ? null : top.busySince || top.since);
    if (islandStyle && !top.muted) {
      // Waveform while the agent thinks; todo progress as a ring.
      bar.wave.hidden = !(vs === 'thinking' || vs === 'agents');
      if (top.todos && top.todos.total) {
        bar.ring.toggleAttribute('hidden', false);
        setRing(bar.ring, top.todos.done / top.todos.total);
        bar.ring.setAttribute('aria-label', `${top.todos.done} of ${top.todos.total} todos`);
      }
    }
  }

  // Colour tag of the session the pill is showing, so you can tell which one it is.
  const shown = textBanner ? sessions.find((s) => s.id === textBanner.sessionId) || { tag: textBanner.tag, name: textBanner.subtitle } : top;
  const tag = shown && shown.tag;
  bar.tag.hidden = !tag;
  bar.tag.className = tag ? `bar-tag tag-${tag}` : 'bar-tag';
  bar.tag.title = tag ? shown.name : '';

  bar.dots.replaceChildren();
  // In island style the split bubble shows the next activity instead of a dot per session.
  if (sessions.length > 1 && !islandStyle) {
    for (const s of sessions) {
      const dot = el('i');
      setStatusClass(dot, visualStatus(s));
      dot.classList.toggle('muted', !!s.muted);
      if (s.tag) dot.classList.add('tagged', `tag-${s.tag}`);
      dot.title = `${s.name}: ${displayLabel(s)}${s.muted ? ' (muted)' : ''}`;
      bar.dots.append(dot);
    }
  }
  renderBanner();
  renderBubble();
  morphOnChange();
  resize();
}

// ---- Banners: the pill grows into a card for a few seconds on events ----

let banner = null;
let bannerQueue = [];
let bannerTimer = null;
let bannerEndsAt = 0;
let bannerRemaining = 0;
let bannerHover = false;
let bannerSeq = 0;

function pushBanner(b) {
  if (!b) return;
  // As text in the pill there is no room for "needs you" or track changes (the pill shows those).
  if (!cardBanners() && (b.kind === 'attention' || b.kind === 'media')) return;
  bannerQueue = bannerQueue.filter((q) => q.key !== b.key);
  if (!banner || banner.key === b.key || (b.urgent && !banner.urgent)) showBanner(b);
  else {
    bannerQueue.push(b);
    if (bannerQueue.length > 4) bannerQueue.shift();
  }
}

function showBanner(b) {
  banner = { ...b, id: ++bannerSeq };
  // While the pointer is on the banner it waits; it gets its full time once the pointer leaves.
  if (bannerHover) {
    clearTimeout(bannerTimer);
    bannerRemaining = b.ms || 3500;
  } else startBannerTimer(b.ms || 3500);
  renderBar();
}

function startBannerTimer(ms) {
  clearTimeout(bannerTimer);
  bannerEndsAt = Date.now() + ms;
  bannerTimer = setTimeout(endBanner, ms);
}

function pauseBanner() {
  if (!banner) return;
  clearTimeout(bannerTimer);
  bannerRemaining = Math.max(1500, bannerEndsAt - Date.now());
}

function endBanner() {
  clearTimeout(bannerTimer);
  banner = null;
  const next = bannerQueue.shift();
  if (next) {
    showBanner(next);
    return;
  }
  bannerHover = false;
  renderBar();
}

// Clears banners after it was handled (clicked or swiped away).
function dismissBanner() {
  if (!banner) return;
  hoverSuppressed = hovering;
  bannerHover = false;
  endBanner();
}

function bannerIcon(b) {
  const icon = el('span', 'glyph');
  if (b.kind === 'media') {
    if (b.art) {
      const img = el('img');
      img.src = b.art;
      img.alt = '';
      img.draggable = false;
      return img;
    }
    icon.textContent = '♪';
  } else if (b.kind === 'battery') {
    const battery = el('span', `battery${b.charging ? ' charging' : ''}`);
    const fill = el('b');
    fill.style.width = `${Math.round((b.level || 0) * 100)}%`;
    battery.append(fill);
    return battery;
  } else if (b.kind === 'timer') icon.textContent = '⏱';
  else if (b.status === 'done') icon.textContent = '✓';
  else if (b.status === 'error') icon.textContent = '✕';
  else icon.textContent = '!';
  return icon;
}

function renderBanner() {
  const show = bannerShown();
  bannerEl.hidden = !show;
  if (!show || bannerEl.dataset.id === String(banner.id)) return;
  bannerEl.dataset.id = String(banner.id);
  bannerEl.className = `banner kind-${banner.kind}`;
  setStatusClass(bannerEl, banner.status);
  if (banner.tag) bannerEl.classList.add('tagged', `tag-${banner.tag}`);
  bannerParts.icon.replaceChildren(bannerIcon(banner));
  bannerParts.title.textContent = banner.title;
  bannerParts.sub.textContent = banner.subtitle || '';
  bannerParts.sub.title = banner.subtitle || '';
  const side = [];
  if (banner.kind === 'media') side.push(makeWave(true));
  else if (banner.kind === 'battery') side.push(document.createTextNode(`${Math.round((banner.level || 0) * 100)}%`));
  else if (banner.sessionId) side.push(document.createTextNode('Open ›'));
  bannerParts.side.replaceChildren(...side);
  bannerEl.title = banner.sessionId ? 'Click to open the terminal · swipe up to dismiss' : 'Click or swipe up to dismiss';
}

function bannerAction() {
  const b = banner;
  if (!b) return;
  if (b.sessionId) window.notchApi.focusSession(b.sessionId);
  dismissBanner();
}

// ---- Split bubble: the second live activity pops out beside the pill ----

function renderBubble() {
  const sec =
    islandStyle && !expanded && !bannerShown() && !dropping && !notch.classList.contains('dot-only') ? plan.secondary : null;
  island.classList.toggle('split', !!sec);
  // When it goes away the old content stays for the shrink animation.
  if (!sec) return;
  const parts = [];
  let status = 'idle';
  let title = '';
  if (sec.kind === 'session') {
    const s = sec.session;
    status = visualStatus(s);
    const indicator = el('span', 'indicator');
    indicator.append(el('span', 'core'));
    parts.push(indicator);
    title = `${s.name}: ${displayLabel(s)} — click to open its terminal`;
    if (s.tag) parts.push(el('span', `bubble-tag tag-${s.tag}`));
  } else if (sec.kind === 'media') {
    status = 'media';
    const m = sec.media;
    if (m.art) {
      const img = el('img', 'art');
      img.src = m.art;
      img.alt = '';
      img.draggable = false;
      parts.push(img);
    } else parts.push(makeWave(true));
    title = `${[m.title, m.artist].filter(Boolean).join(' — ')} — click to play/pause`;
  } else if (sec.kind === 'timer') {
    status = 'timer';
    const ring = makeRing('ring timer-ring');
    setRing(ring, window.NotchIsland.timerProgress(sec.timer));
    parts.push(ring);
    title = `${sec.timer.mode === 'timer' ? 'Timer' : 'Stopwatch'} ${timerClock(sec.timer)} — click to ${sec.timer.runningSince ? 'pause' : 'resume'}`;
  }
  if (plan.more) parts.push(el('span', 'bubble-more', `+${plan.more}`));
  setStatusClass(bubbleEl, status);
  bubbleEl.dataset.kind = sec.kind;
  bubbleEl.dataset.id = sec.id;
  bubbleBody.replaceChildren(...parts);
  bubbleBody.title = title;
}

bubbleBody.addEventListener('click', (e) => {
  e.stopPropagation();
  const kind = bubbleEl.dataset.kind;
  if (kind === 'session') window.notchApi.focusSession(bubbleEl.dataset.id);
  else if (kind === 'media') window.notchApi.mediaCommand('toggle');
  else if (kind === 'timer') window.notchApi.timerAction('toggle');
});

// ---- Squish: the island bounces and its content un-blurs when what it shows changes ----

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let lastShapeKey = '';

function squish(strength = 1) {
  if (!islandStyle || reducedMotion.matches) return;
  const sx = 1 + 0.04 * strength;
  const sy = 1 - 0.1 * strength;
  notch.animate(
    [
      { transform: 'scale(1, 1)' },
      { transform: `scale(${sx}, ${sy})`, offset: 0.28 },
      { transform: `scale(${1 - 0.015 * strength}, ${1 + 0.04 * strength})`, offset: 0.62 },
      { transform: 'scale(1, 1)' },
    ],
    { duration: 520, easing: 'ease-out' }
  );
}

function morphOnChange() {
  const key = [
    plan.primary.kind,
    plan.primary.id,
    plan.primary.kind === 'session' ? visualStatus(plan.primary.session) : '',
    bannerShown() ? banner.id : '',
  ].join('|');
  if (key === lastShapeKey) return;
  const first = !lastShapeKey;
  lastShapeKey = key;
  if (first || expanded || !islandStyle || reducedMotion.matches) return;
  squish();
  const content = bannerShown() ? bannerEl : notch.querySelector('.bar');
  content.animate(
    [
      { filter: 'blur(5px)', opacity: 0.15, transform: 'scale(0.94)' },
      { filter: 'blur(0)', opacity: 1, transform: 'none' },
    ],
    { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
  );
}

function cardLabel(s) {
  const parts = [s.name, displayLabel(s)];
  if (s.tag) parts.push(`${s.tag} tag`);
  if (s.muted) parts.push('muted');
  if (s.detail) parts.push(s.detail);
  if (s.todos && s.todos.total) parts.push(`${s.todos.done} of ${s.todos.total} todos done`);
  return parts.join('. ');
}

function tagSwatch(color) {
  const swatch = el('span', `tag-swatch tag-${color}`);
  swatch.setAttribute('aria-hidden', 'true');
  return swatch;
}

// ---- Naming a card ----
// The text box is one node kept across re-renders (cards are rebuilt on every update), so
// typing isn't interrupted. Enter saves, Esc cancels; an empty name goes back to Copilot's.
let renaming = null; // { id, input }

function startRename(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) {
    window.notchApi.renameDone();
    return;
  }
  const input = el('input', 'name rename-input');
  input.type = 'text';
  input.value = s.name;
  input.maxLength = 60;
  input.spellcheck = false;
  input.placeholder = s.originalName || 'Session name';
  input.setAttribute('aria-label', `Name for ${s.originalName || s.name}. Enter to save, Escape to cancel.`);
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finishRename(true);
    else if (e.key === 'Escape') finishRename(false);
  });
  renaming = { id, input, fromKeyboard: keyboardMode };
  if (!expanded) expand();
  renderPanel();
  if (keyboardMode) {
    input.focus();
    input.select();
  } else pendingFocus = input;
}

function finishRename(save) {
  if (!renaming) return;
  const { id, input, fromKeyboard } = renaming;
  renaming = null;
  if (save) window.notchApi.renameSession(id, input.value);
  renderPanel();
  // Started with F2 in keyboard mode: put focus back on the card. Otherwise let it go.
  if (fromKeyboard && keyboardMode) {
    const card = [...cards.querySelectorAll('.card')].find((c) => c.dataset.id === id);
    if (card) card.focus();
  } else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  window.notchApi.renameDone();
}

window.notchApi.onRename(startRename);

function renderCard(s) {
  const vs = visualStatus(s);
  const card = el('div', 'card');
  setStatusClass(card, vs);
  card.classList.toggle('overdue', s.stuck === 'waiting' && !s.muted);
  card.classList.toggle('muted', !!s.muted);
  card.title = 'Click to open this session’s terminal';
  card.dataset.id = s.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', cardLabel(s));
  card.setAttribute('aria-keyshortcuts', 'Enter Shift+F10 F2');

  const row = el('div', 'row');
  const indicator = el('span', 'indicator');
  indicator.setAttribute('aria-hidden', 'true');
  indicator.append(el('span', 'core'));
  const chip = el('span', 'chip', displayLabel(s));
  const more = el('button', 'more', '⋯');
  more.title = 'More actions';
  more.setAttribute('aria-label', `More actions for ${s.name}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    window.notchApi.showSessionMenu(s.id);
  });
  const editing = !!renaming && renaming.id === s.id;
  const name = editing ? renaming.input : el('span', 'name', s.name);
  if (!editing) {
    if (s.originalName) name.title = `Your name for this session. ${agentInfo(s.agent).label} calls it: ${s.originalName}`;
    if (s.tag) name.prepend(tagSwatch(s.tag));
    if (s.muted) name.prepend(el('span', 'muted-badge', '🔕 '));
  }
  if (s.tag) card.classList.add('tagged', `tag-${s.tag}`);
  row.append(indicator, name, chip, more);
  card.append(row);

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.notchApi.showSessionMenu(s.id);
  });
  const open = async () => {
    card.classList.add('focusing');
    const result = await window.notchApi.focusSession(s.id);
    card.classList.remove('focusing');
    if (!result || !result.ok) {
      chip.textContent = 'Terminal not found';
      announce('Terminal not found', false);
      setTimeout(() => (chip.textContent = displayLabel(s)), 2000);
    }
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open();
    }
  });

  if (s.lastPrompt) {
    const prompt = el('p', 'prompt', `› ${s.lastPrompt}`);
    prompt.title = `Your last prompt: ${s.lastPrompt}`;
    card.append(prompt);
  }
  if (s.pendingApproval) {
    card.append(renderApproval(s.pendingApproval));
  } else if (s.pendingQuestion) {
    card.append(renderQuestion(s.pendingQuestion));
  } else if (s.detail) {
    card.append(el('p', CODE_STATUSES.has(s.status) ? 'text code' : 'text', s.detail));
  }
  if (s.warning) card.append(el('p', 'warning', `⚠ ${s.warning}`));
  const todos = renderTodos(s);
  if (todos) card.append(todos);

  const info = el('div', 'info');
  if (s.wsl) {
    const tag = el('span', 'wsl', 'WSL');
    tag.title = `Running in WSL (${s.wsl})`;
    info.append(tag);
  }
  if (s.cwd) {
    const cwd = el('span', null, `📁 ${shortPath(s.cwd)}`);
    cwd.title = s.wsl ? `${s.cwd} in ${s.wsl}` : s.cwd;
    info.append(cwd);
  }
  const branch = renderGit(s.git);
  if (branch) info.append(branch);
  const elapsed = el('span', 'elapsed');
  const since = s.status === 'idle' ? s.since : s.busySince || s.since;
  elapsed.dataset.since = since || '';
  elapsed.dataset.suffix = s.status === 'idle' ? ' ago' : '';
  elapsed.textContent = since ? formatElapsed(since) + elapsed.dataset.suffix : '';
  info.append(elapsed);
  card.append(info);

  const usage = renderUsage(s);
  if (usage) card.append(usage);

  const agents = renderAgents(s);
  if (agents) card.append(agents);
  const activity = renderActivity(s);
  if (activity) card.append(activity);
  const files = renderFiles(s);
  if (files) card.append(files);
  return card;
}

const APPROVAL_TITLES = {
  shell: 'Copilot wants to run a command',
  write: 'Copilot wants to change files',
  url: 'Copilot wants to fetch a URL',
};

// A request held by the notch (approve-from-notch). Nothing is approved unless clicked; when the
// countdown ends the request goes back to the terminal prompt.
//
// Accidental approvals are prevented by:
//  - an arming delay: buttons ignore clicks until the box has been visible, and the notch shape
//    unchanged, for APPROVAL_ARM_MS (so a click aimed at a moving layout can't hit Approve);
//  - deliberate pointing: the mouse must move over the button after it is armed;
//  - real pointer clicks only, except in hotkey keyboard mode (stray keystrokes can't approve);
//  - one DOM node per request, reused across re-renders, so a click is never split across nodes.
const APPROVAL_ARM_MS = 700;
const approvalBoxes = new Map(); // request id -> { box, shownAt }
let layoutChangedAt = 0;
let lastShape = { width: 0, zoom: 1 };

function approvalArmed(entry) {
  const now = Date.now();
  return now - entry.shownAt >= APPROVAL_ARM_MS && now - layoutChangedAt >= APPROVAL_ARM_MS;
}

// A button with the accidental-click guards described above. `activate` runs only for a
// deliberate click on an armed box.
function guardedButton(entry, label, cls, hint, activate) {
  const b = el('button', `approval-btn ${cls}`, label);
  b.type = 'button';
  b.title = hint;
  // The pointer must move over this button after it is armed. A cursor that happened to be
  // where the box appeared (parked, or mid-click elsewhere) can never approve.
  let deliberate = false;
  b.addEventListener('pointermove', (e) => {
    if ((e.movementX || e.movementY) && approvalArmed(entry)) deliberate = true;
  });
  b.addEventListener('pointerleave', () => (deliberate = false));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    // e.detail is 0 for keyboard/synthetic activation.
    const keyboard = e.detail === 0;
    if (keyboard && !keyboardMode) return;
    if (!approvalArmed(entry) || (!keyboard && !deliberate)) {
      entry.box.classList.remove('not-ready');
      void entry.box.offsetWidth;
      entry.box.classList.add('not-ready');
      return;
    }
    activate();
  });
  return b;
}

function renderApproval(p) {
  const existing = approvalBoxes.get(p.id);
  if (existing) return existing.box;
  const box = el('div', 'approval');
  const entry = { box, shownAt: Date.now() };
  approvalBoxes.set(p.id, entry);
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Permission request');
  box.addEventListener('click', (e) => e.stopPropagation());
  box.append(el('div', 'approval-title', APPROVAL_TITLES[p.kind] || `Copilot wants to use ${p.toolName || p.kind}`));
  const detail = el('pre', 'approval-detail', p.detail || '(no details)');
  detail.title = p.detail || '';
  box.append(detail);
  if (p.sandboxBypass) box.append(el('p', 'warning', '⚠ Asks to run outside the sandbox — approving here still requires confirming in the terminal.'));
  const actions = el('div', 'approval-actions');
  const button = (label, cls, decision, hint) =>
    guardedButton(entry, label, cls, hint, () => {
      actions.querySelectorAll('button').forEach((x) => (x.disabled = true));
      window.notchApi.decideApproval(p.id, decision);
    });
  actions.append(
    button('Approve', 'allow', 'allow', 'Allow this once'),
    button('Deny', 'deny', 'deny', 'Deny — Copilot is told you declined'),
    button('Terminal', 'terminal', 'terminal', 'Answer in the terminal instead (more options there)')
  );
  actions.append(countdownEl(p.expiresAt));
  box.append(actions);
  return box;
}

function countdownEl(expiresAt) {
  const countdown = el('span', 'countdown');
  countdown.dataset.until = expiresAt;
  countdown.textContent = formatCountdown(expiresAt);
  countdown.title = 'Goes back to the terminal prompt when this runs out';
  return countdown;
}

// Text boxes need keyboard focus; the notch only takes it on request (keyboard mode).
let pendingFocus = null;

function typingInput(type, placeholder, onInput) {
  const input = el('input', 'question-input');
  input.type = type;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('pointerdown', () => {
    if (keyboardMode) return;
    pendingFocus = input;
    window.notchApi.requestTyping();
  });
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

// An ask_user question held by the notch. Choices are plain toggles; only "Send" (guarded like
// the approval buttons) delivers the answer. Unanswered questions go back to the terminal.
function renderQuestion(q) {
  const existing = approvalBoxes.get(q.id);
  if (existing) return existing.box;
  const box = el('div', 'approval question');
  const entry = { box, shownAt: Date.now() };
  approvalBoxes.set(q.id, entry);
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Question from Copilot');
  box.addEventListener('click', (e) => e.stopPropagation());
  box.append(el('div', 'approval-title', 'Copilot is asking'));
  if (q.message) box.append(el('p', 'question-text', q.message));

  const values = {};
  const actions = el('div', 'approval-actions');
  let send = null;
  const ready = () => q.fields.every((f) => !f.required || !isBlank(values[f.key]));
  const update = () => {
    if (send) send.disabled = !ready();
  };

  for (const f of q.fields) {
    if (f.default !== undefined) values[f.key] = Array.isArray(f.default) ? [...f.default] : f.default;
    const field = el('div', 'question-field');
    const title = el('div', 'question-label', f.title + (f.required ? ' *' : ''));
    if (f.description) title.title = f.description;
    field.append(title);
    if (f.kind === 'choice' || f.kind === 'boolean' || f.kind === 'multi') {
      const options = f.kind === 'boolean' ? [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] : f.options;
      const group = el('div', 'question-options');
      group.setAttribute('role', f.kind === 'multi' ? 'group' : 'radiogroup');
      group.setAttribute('aria-label', f.title);
      let other = null;
      const chips = options.map((o) => {
        const chip = el('button', 'question-chip', o.label);
        chip.type = 'button';
        chip.title = o.label;
        chip.setAttribute(f.kind === 'multi' ? 'aria-pressed' : 'aria-checked', 'false');
        if (f.kind !== 'multi') chip.setAttribute('role', 'radio');
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          if (f.kind === 'multi') {
            const set = new Set(values[f.key] || []);
            if (set.has(o.value)) set.delete(o.value);
            else set.add(o.value);
            values[f.key] = options.map((x) => x.value).filter((v) => set.has(v));
          } else {
            values[f.key] = o.value;
            if (other) other.value = '';
          }
          sync();
        });
        return chip;
      });
      const sync = () => {
        chips.forEach((chip, i) => {
          const v = values[f.key];
          const on = f.kind === 'multi' ? (v || []).includes(options[i].value) : v === options[i].value;
          chip.classList.toggle('selected', on);
          chip.setAttribute(f.kind === 'multi' ? 'aria-pressed' : 'aria-checked', String(on));
        });
        update();
      };
      group.append(...chips);
      field.append(group);
      if (f.freeform) {
        other = typingInput('text', 'Other…', (text) => {
          values[f.key] = text;
          sync();
        });
        other.setAttribute('aria-label', `${f.title}: other answer`);
        field.append(other);
      }
      sync();
    } else {
      const input = typingInput(f.kind === 'number' ? 'number' : 'text', f.kind === 'number' ? 'Number' : 'Type your answer', (text) => {
        values[f.key] = f.kind === 'number' ? (text === '' ? undefined : Number(text)) : text;
        update();
      });
      if (f.kind === 'number') {
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.integer) input.step = '1';
      }
      if (f.default !== undefined) input.value = String(f.default);
      input.setAttribute('aria-label', f.title);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !send.disabled) {
          e.preventDefault();
          send.click();
        }
      });
      field.append(input);
    }
    box.append(field);
  }

  const failed = el('p', 'warning question-error');
  failed.hidden = true;
  send = guardedButton(entry, 'Send', 'allow', 'Send this answer to Copilot', async () => {
    actions.querySelectorAll('button').forEach((x) => (x.disabled = true));
    const ok = await window.notchApi.answerQuestion(q.id, values);
    if (!ok) {
      failed.textContent = '⚠ That answer doesn’t fit the question — check the fields, or use Terminal.';
      failed.hidden = false;
      actions.querySelectorAll('button').forEach((x) => (x.disabled = false));
      update();
    }
  });
  actions.append(
    send,
    guardedButton(entry, 'Terminal', 'terminal', 'Answer in the terminal instead', () => {
      actions.querySelectorAll('button').forEach((x) => (x.disabled = true));
      window.notchApi.decideApproval(q.id, 'terminal');
    }),
    countdownEl(q.expiresAt)
  );
  box.append(failed, actions);
  update();
  return box;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && !Number.isFinite(v)) || (Array.isArray(v) && v.length === 0);
}

// Drop boxes for requests that are no longer pending.
function pruneApprovalBoxes() {
  const live = new Set(sessions.map((s) => (s.pendingApproval || s.pendingQuestion || {}).id).filter(Boolean));
  for (const id of approvalBoxes.keys()) if (!live.has(id)) approvalBoxes.delete(id);
}

function formatCountdown(until) {
  return `${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsed(Date.now() - ms);
}

// A collapsible card section; its open/closed state survives re-renders. Sections without an
// explicit choice use `defaultOpen`.
function section(s, key, label, defaultOpen, renderBody) {
  const id = `${s.id}:${key}`;
  const open = openSections.has(id) ? openSections.get(id) : defaultOpen;
  const wrap = el('div', `section ${key}`);
  const toggle = el('button', 'section-toggle', `${open ? '▾' : '▸'} ${label}`);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    openSections.set(id, !open);
    renderPanel();
  });
  wrap.append(toggle);
  if (open) wrap.append(renderBody());
  return wrap;
}

function renderActivity(s) {
  const items = s.activity || [];
  if (!items.length) return null;
  return section(s, 'activity', 'Recent activity', false, () => {
    const list = el('ul', 'activity-list');
    for (const a of items) {
      const li = el('li', a.running ? 'running' : a.ok === false ? 'failed' : 'ok');
      const mark = el('span', 'mark', a.running ? '●' : a.ok === false ? '✕' : '✓');
      mark.setAttribute('aria-label', a.running ? 'running' : a.ok === false ? 'failed' : 'succeeded');
      const text = el('span', 'what', a.detail ? `${a.title} · ${a.detail}` : a.title);
      text.title = text.textContent;
      const time = el('span', 'time');
      if (a.running) {
        time.dataset.since = a.since;
        time.textContent = formatElapsed(a.since);
      } else {
        time.textContent = formatDuration(a.durationMs);
      }
      li.append(mark, text, time);
      list.append(li);
    }
    return list;
  });
}

// Subagent tree: running agents (model, elapsed, tool calls, current step) and the last few
// that finished, with their totals.
function renderAgents(s) {
  const running = s.agents || [];
  const done = s.agentHistory || [];
  if (!running.length && !done.length) return null;
  const label = running.length
    ? `Subagents · ${running.length} running${done.length ? `, ${done.length} done` : ''}`
    : `Subagents · ${done.length} done`;
  return section(s, 'agents', label, running.length > 0, () => {
    const tree = el('ul', 'agent-tree');
    for (const a of running) {
      const li = el('li', 'agent running');
      const head = el('div', 'agent-head');
      head.append(el('span', 'mark', '●'), el('b', null, a.name));
      const meta = el('span', 'meta');
      const since = el('span');
      since.dataset.since = a.startedAt;
      since.textContent = formatElapsed(a.startedAt);
      meta.append(since, document.createTextNode(` · ${a.toolCalls} tool${a.toolCalls === 1 ? '' : 's'}`));
      if (a.model) meta.append(document.createTextNode(' · '), modelTag(a.model, 'busy'));
      head.append(meta);
      const step = el('div', 'agent-step', a.activity);
      step.title = a.activity;
      li.append(head, step);
      li.title = a.description || a.name;
      tree.append(li);
    }
    for (const a of done) {
      const li = el('li', `agent finished ${a.ok ? 'ok' : 'failed'}`);
      const head = el('div', 'agent-head');
      head.append(el('span', 'mark', a.ok ? '✓' : '✕'), el('b', null, a.name));
      const parts = [formatDuration(a.durationMs), `${a.toolCalls} tool${a.toolCalls === 1 ? '' : 's'}`];
      if (a.tokens) parts.push(`${formatTokens(a.tokens)} tok`);
      head.append(el('span', 'meta', parts.join(' · ')));
      li.append(head);
      li.title = [a.description, a.model].filter(Boolean).join(' · ') || a.name;
      tree.append(li);
    }
    return tree;
  });
}

const FILE_MARKS = { created: ['+', 'created'], edited: ['✎', 'edited'], deleted: ['−', 'deleted'] };
const FILES_SHOWN = 12;

function splitPath(p) {
  const parts = String(p).split(/[\\/]/);
  const name = parts.pop() || p;
  return { name, dir: shortPath(parts.join(String(p).startsWith('/') ? '/' : '\\')) };
}

// Files this session created, edited or deleted. Click one to show it in Explorer.
function renderFiles(s) {
  const f = s.files;
  if (!f || !f.total) return null;
  return section(s, 'files', `${f.total} file${f.total === 1 ? '' : 's'} changed`, false, () => {
    const list = el('ul', 'file-list');
    for (const file of f.list.slice(0, FILES_SHOWN)) {
      const [mark, kind] = FILE_MARKS[file.kind] || FILE_MARKS.edited;
      const { name, dir } = splitPath(file.path);
      const li = el('li', `file ${kind}`);
      const m = el('span', 'mark', mark);
      m.setAttribute('aria-label', kind);
      li.append(m, el('span', 'fname', name), el('span', 'fdir', dir));
      if (file.edits > 1) li.append(el('span', 'count', `×${file.edits}`));
      li.title = `${file.path}\n${kind}${file.by ? ` by ${file.by}` : ''} · ${file.edits} change${file.edits === 1 ? '' : 's'}${
        file.kind === 'deleted' ? '' : '\nClick to show in Explorer'
      }`;
      if (file.kind !== 'deleted') {
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        const reveal = (e) => {
          e.stopPropagation();
          window.notchApi.revealFile(s.id, file.path);
        };
        li.addEventListener('click', reveal);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') reveal(e);
        });
      }
      list.append(li);
    }
    if (f.total > FILES_SHOWN) list.append(el('li', 'more-files', `+${f.total - FILES_SHOWN} more`));
    return list;
  });
}

function todoPercent(t) {
  return t && t.total ? Math.round((t.done / t.total) * 100) : 0;
}

// "▰▰▱ 5/8 todos · Now: Building watcher" for sessions that keep a todo list.
function renderTodos(s) {
  const t = s.todos;
  if (!t || !t.total) return null;
  const row = el('div', 'todos');
  const meter = el('i', 'meter');
  const fill = el('b');
  fill.style.width = `${todoPercent(t)}%`;
  meter.append(fill);
  const count = el('span', 'count', `${t.done}/${t.total} todos`);
  row.append(meter, count);
  if (t.blocked) row.append(el('span', 'blocked', `${t.blocked} blocked`));
  if (t.current) {
    const now = el('span', 'current', `Now: ${t.current}`);
    now.title = t.current;
    row.append(now);
  }
  row.title = s.planTitle ? `Plan: ${s.planTitle}` : 'Session todo list';
  return row;
}

function renderGit(g) {
  if (!g || !g.branch) return null;
  let text = `⎇ ${g.branch}`;
  if (g.ahead) text += ` ↑${g.ahead}`;
  if (g.behind) text += ` ↓${g.behind}`;
  const span = el('span', 'git', text);
  if (g.changed) span.append(el('b', 'dirty', ` ●${g.changed}`));
  const parts = [`Branch ${g.branch}${g.detached ? ' (detached HEAD)' : ''}`];
  if (g.ahead || g.behind) parts.push(`${g.ahead} ahead, ${g.behind} behind upstream`);
  parts.push(g.changed ? `${g.changed} changed file${g.changed === 1 ? '' : 's'}` : 'working tree clean');
  span.title = parts.join(' · ');
  return span;
}

function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function level(pct, warnAt, dangerAt) {
  return pct >= dangerAt ? 'danger' : pct >= warnAt ? 'warn' : 'ok';
}

// Must match the animation durations of .mascot.busy / .mascot.alert in styles.css.
const MASCOT_CYCLE_MS = { busy: 1400, alert: 1200 };

// Model name with its family's mascot (Claude / Codex / Gemini); other models keep the ✦ mark.
// The mascot bobs while the session works and wiggles when it needs you.
function modelTag(model, mood) {
  const { modelFamily, mascotImage, familyLabel } = window.NotchMascots;
  const family = modelFamily(model);
  const tag = el('span', 'model');
  if (family) {
    const mascot = el('span', `mascot ${family}${mood ? ` ${mood}` : ''}`);
    const img = el('img');
    img.src = mascotImage(family);
    img.alt = '';
    img.draggable = false;
    mascot.append(img);
    // Cards are rebuilt on every update; a clock-based phase keeps the animation continuous.
    if (mood) mascot.style.animationDelay = `-${Date.now() % MASCOT_CYCLE_MS[mood]}ms`;
    tag.append(mascot);
    tag.dataset.family = family;
  } else {
    tag.append(el('span', 'mascot generic', '✦'));
  }
  tag.append(el('span', 'model-name', model));
  tag.setAttribute('aria-label', family ? `${familyLabel(family)} model ${model}` : `Model ${model}`);
  return tag;
}

function mascotMood(status) {
  if (status === 'approval' || status === 'input') return 'alert';
  if (status === 'thinking' || status === 'tool' || status === 'agents') return 'busy';
  return '';
}

function renderUsage(s) {
  const u = s.usage;
  const row = el('div', 'usage');
  if (s.model) {
    const model = modelTag(s.model, s.muted ? '' : mascotMood(s.status));
    model.title = s.cliVersion ? `${s.model} · ${agentInfo(s.agent).cli} v${s.cliVersion}` : s.model;
    row.append(model);
  }
  if (!u || (!u.premiumRequests && !u.outputTokens && !u.contextLimit)) {
    if (s.cliVersion) row.append(el('span', 'version', `v${s.cliVersion}`));
    return row.childElementCount ? row : null;
  }
  // Premium requests are a Copilot billing unit.
  if (u.premiumRequests || (s.agent || 'copilot') === 'copilot') {
    const premium = el('span', null, `⚡ ${u.premiumRequests}`);
    premium.title = `${u.premiumRequests} premium requests used by this session`;
    row.append(premium);
  }
  if (u.outputTokens) {
    const out = el('span', null, `${formatTokens(u.outputTokens)} out`);
    out.title = 'Output tokens generated in this session';
    row.append(out);
  }
  if (u.contextLimit) {
    const pct = Math.min(100, Math.round((u.contextTokens / u.contextLimit) * 100));
    const ctx = el('span', `ctx ${level(pct, 70, 90)}`);
    const meter = el('i', 'meter');
    const fill = el('b');
    fill.style.width = `${pct}%`;
    meter.append(fill);
    ctx.append(meter, document.createTextNode(`${pct}% ctx`));
    ctx.title = `Context window: ${formatTokens(u.contextTokens)} of ${formatTokens(u.contextLimit)} tokens`;
    row.append(ctx);
  }
  return row;
}

// The newest premium-quota snapshot across sessions (it is account-wide).
function renderQuota() {
  const q = sessions
    .map((s) => s.quota)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)[0];
  quotaEl.className = 'quota';
  if (!q || q.unlimited) {
    quotaEl.textContent = '';
    return;
  }
  const left = Math.max(0, q.remainingPercentage);
  const reset = q.resetDate ? new Date(q.resetDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  quotaEl.textContent = `Premium ${Math.round(left)}% left${reset ? ` · resets ${reset}` : ''}`;
  quotaEl.classList.add(level(100 - left, 80, 95));
  quotaEl.title = `${q.used.toLocaleString()} of ${q.entitlement.toLocaleString()} premium requests used${q.overage ? ` (+${q.overage} overage)` : ''}`;
}

// "Earlier" list of sessions that ended in the last 30 minutes.
function renderEnded() {
  if (!ended.length) return [];
  const header = el('div', 'ended-header', 'Recently ended');
  const rows = ended.map((e) => {
    const row = el('div', 'ended');
    row.title = [e.lastPrompt && `› ${e.lastPrompt}`, e.summary, 'Click for options'].filter(Boolean).join('\n');
    const name = el('span', 'name', e.name);
    const meta = el('span', 'meta');
    const ago = el('span');
    ago.dataset.since = e.endedAt;
    ago.dataset.suffix = ' ago';
    ago.textContent = `${formatElapsed(e.endedAt)} ago`;
    meta.append(ago);
    if (e.premiumRequests) meta.append(document.createTextNode(` · ⚡ ${e.premiumRequests}`));
    if (e.todos && e.todos.total) meta.append(document.createTextNode(` · ${e.todos.done}/${e.todos.total} todos`));
    row.append(el('span', 'mark', '■'), name, meta);
    if (e.tag) {
      row.classList.add('tagged', `tag-${e.tag}`);
      name.prepend(tagSwatch(e.tag));
    }
    row.tabIndex = 0;
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${e.name}, ended ${formatElapsed(e.endedAt)} ago. Press Enter for options.`);
    row.querySelector('.mark').setAttribute('aria-hidden', 'true');
    const open = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      window.notchApi.showEndedMenu(e.id);
    };
    row.addEventListener('click', open);
    row.addEventListener('contextmenu', open);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') open(ev);
    });
    return row;
  });
  return [header, ...rows];
}

function renderPanel() {
  // Cards are rebuilt; keep keyboard focus (and the caret) where it was.
  const active = document.activeElement;
  const activeCardId = active && active.classList && active.classList.contains('card') ? active.dataset.id : null;
  const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  countEl.textContent = `${sessions.length} live session${sessions.length === 1 ? '' : 's'}`;
  renderQuota();
  const scrollTop = cards.scrollTop;
  const live = sessions.length
    ? sessions.map(renderCard)
    : [el('div', 'empty-card', `Start \`${agentInfo(agent).command}\` in a terminal to see it here.`)];
  cards.replaceChildren(...live, ...renderEnded());
  cards.scrollTop = scrollTop;
  if (active && active !== document.body && document.activeElement !== active) {
    if (active.isConnected) {
      active.focus({ preventScroll: true });
      if (caret) {
        try {
          active.setSelectionRange(caret[0], caret[1]);
        } catch {
          // number inputs don't support selection
        }
      }
    } else if (activeCardId) {
      const card = [...cards.querySelectorAll('.card')].find((c) => c.dataset.id === activeCardId);
      if (card) card.focus({ preventScroll: true });
    }
  }
  resize();
}

function resize() {
  const bannerCard = bannerShown();
  let width = islandStyle ? ISLAND_WIDTH : COLLAPSED_WIDTH;
  let height = BAR_HEIGHT;
  if (expanded) {
    width = EXPANDED_WIDTH;
    height = Math.min(MAX_HEIGHT, BAR_HEIGHT + panel.scrollHeight);
  } else if (bannerCard) {
    width = BANNER_WIDTH;
    height = BANNER_HEIGHT;
  } else if (notch.classList.contains('dot-only')) width = DOT_WIDTH;
  else if (notch.classList.contains('empty')) width = EMPTY_WIDTH;
  notch.style.width = `${width}px`;
  notch.style.height = `${height}px`;
  island.style.zoom = String(zoom);
  // Approval buttons stay disarmed until the shape has settled (see renderApproval).
  if (width !== lastShape.width || zoom !== lastShape.zoom) layoutChangedAt = Date.now();
  lastShape = { width, zoom };
  // Report the target bounds (not the animating ones) so hover tracking matches the final shape:
  // the pill, plus the split bubble beside it. The island is [shoulder pill shoulder][bubble].
  const shoulder = islandStyle ? SHOULDER : 0;
  const split = island.classList.contains('split');
  const total = (shoulder * 2 + width + (split ? BUBBLE_SHOULDER * 2 + BUBBLE_WIDTH : 0)) * zoom;
  const left = align === 'left' ? 0 : align === 'right' ? window.innerWidth - total : (window.innerWidth - total) / 2;
  const extra = split
    ? [{ x: left + (shoulder * 2 + width + BUBBLE_SHOULDER) * zoom, y: 0, width: BUBBLE_WIDTH * zoom, height: BAR_HEIGHT * zoom }]
    : [];
  window.notchApi.reportRect({ x: left + shoulder * zoom, y: 0, width: width * zoom, height: height * zoom, extra });
}

function render() {
  renderBar();
  renderPanel();
}

function tick() {
  for (const node of notch.querySelectorAll('[data-since]')) {
    const since = Number(node.dataset.since);
    node.textContent = since ? formatElapsed(since) + (node.dataset.suffix || '') : '';
  }
  for (const node of notch.querySelectorAll('[data-until]')) node.textContent = formatCountdown(Number(node.dataset.until));
}

// Timer clocks, progress rings and media positions move several times a second.
function liveTick() {
  const now = Date.now();
  const t = features.timer && extras.timer;
  if (t) {
    if (bar.elapsed.dataset.clock === 'timer') bar.elapsed.textContent = timerClock(t, now);
    if (plan.primary.kind === 'timer' && !bar.ring.hasAttribute('hidden')) setRing(bar.ring, window.NotchIsland.timerProgress(t, now));
    const bubbleRing = bubbleBody.querySelector('.timer-ring');
    if (bubbleRing) setRing(bubbleRing, window.NotchIsland.timerProgress(t, now));
  }
  if (expanded) liveTickExtras(now);
}

function expand() {
  clearTimeout(collapseTimer);
  notch.classList.remove('peek');
  if (expanded) return;
  expanded = true;
  notch.classList.add('expanded');
  renderBar();
}

function collapse() {
  clearTimeout(collapseTimer);
  if (pinned || heldOpen) return;
  collapseTimer = setTimeout(() => {
    expanded = false;
    notch.classList.remove('expanded');
    renderBar();
  }, COLLAPSE_DELAY_MS);
}

// Close now (swipe up / click in click-to-open mode), even with the pointer still over it.
function forceCollapse() {
  clearTimeout(collapseTimer);
  if (pinned) window.notchApi.togglePin();
  hoverSuppressed = hovering;
  if (!expanded) return;
  expanded = false;
  notch.classList.remove('expanded');
  renderBar();
}

function setPinned(value) {
  pinned = !!value;
  notch.classList.toggle('pinned', pinned);
  pinButton.title = pinned ? 'Unpin' : 'Pin expanded';
  pinButton.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin expanded');
  pinButton.setAttribute('aria-pressed', String(pinned));
  if (pinned) expand();
  else if (!hovering) collapse();
}

function flash(kind) {
  const cls = kind === 'error' ? 'flash-error' : 'flash-done';
  notch.classList.remove('flash-done', 'flash-error');
  void notch.offsetWidth; // restart the animation
  notch.classList.add(cls);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => notch.classList.remove(cls), 1900);
}

window.notchApi.onHover((value, region) => {
  hovering = value;
  if (!value) {
    hoverSuppressed = false;
    notch.classList.remove('peek');
    if (dropping) endDrop();
    if (bannerHover) {
      bannerHover = false;
      if (banner) startBannerTimer(bannerRemaining || 1500);
    }
    collapse();
    return;
  }
  // The split bubble takes clicks (open, play/pause); only the pill itself opens the panel.
  if (region === 'bubble') {
    clearTimeout(collapseTimer);
    notch.classList.remove('peek');
    return;
  }
  // A banner stays (and waits) while the pointer is on it, so it can be clicked.
  if (bannerShown()) {
    bannerHover = true;
    pauseBanner();
    return;
  }
  if (expandOn === 'hover' && !hoverSuppressed) expand();
  else if (!expanded) {
    clearTimeout(collapseTimer);
    notch.classList.add('peek');
  }
});

pinButton.addEventListener('click', (e) => {
  e.stopPropagation();
  window.notchApi.togglePin();
});
window.notchApi.onPinned(setPinned);
window.notchApi.getPinned().then(setPinned);

timerButton.addEventListener('click', (e) => {
  e.stopPropagation();
  window.notchApi.timerMenu();
});

// The running timer in the panel header: click to pause/resume, right-click for the timer menu.
timerChip.addEventListener('click', (e) => {
  e.stopPropagation();
  window.notchApi.timerAction('toggle');
});
timerChip.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  window.notchApi.timerMenu();
});

// Gestures on the pill's top bar:
//  - drag sideways to move it (double-click to snap back);
//  - swipe down to open (or pin open), swipe up to close;
//  - long-press to pin / unpin;
//  - click to open/close in click-to-open mode;
//  - scroll to switch which session the pill shows.
const DRAG_THRESHOLD = 4;
const SWIPE_THRESHOLD = 10;
const barEl = notch.querySelector('.bar');
let gesture = null;

barEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  gesture = { startX: e.screenX, startY: e.screenY, mode: null, frame: 0, press: setTimeout(longPress, LONG_PRESS_MS) };
  barEl.setPointerCapture(e.pointerId);
  // The main process measures from the cursor position at this moment.
  window.notchApi.drag('start');
});

function longPress() {
  if (!gesture || gesture.mode) return;
  gesture.mode = 'press';
  window.notchApi.drag('cancel');
  window.notchApi.togglePin();
  squish(0.6);
}

barEl.addEventListener('pointermove', (e) => {
  if (!gesture) return;
  const dx = e.screenX - gesture.startX;
  const dy = e.screenY - gesture.startY;
  if (!gesture.mode) {
    if (Math.abs(dy) >= SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx) * 1.5) {
      gesture.mode = 'swipe';
      clearTimeout(gesture.press);
      window.notchApi.drag('cancel');
      return;
    }
    if (Math.abs(dx) < DRAG_THRESHOLD) return;
    gesture.mode = 'drag';
    clearTimeout(gesture.press);
    notch.classList.add('dragging');
  }
  if (gesture.mode !== 'drag') return;
  // Coalesce to one window move per frame.
  if (!gesture.frame) {
    gesture.frame = requestAnimationFrame(() => {
      if (!gesture) return;
      gesture.frame = 0;
      window.notchApi.drag('move');
    });
  }
});

function endGesture(e) {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  clearTimeout(g.press);
  if (g.frame) cancelAnimationFrame(g.frame);
  notch.classList.remove('dragging');
  if (g.mode === 'drag') {
    window.notchApi.drag('end');
    return;
  }
  if (g.mode === 'swipe') {
    if (e.type === 'pointercancel') return;
    if (e.screenY > g.startY) {
      // Swipe down: open; when already open, keep it open.
      if (!expanded) expand();
      else if (!pinned) window.notchApi.togglePin();
    } else forceCollapse();
    return;
  }
  if (g.mode === 'press') return;
  // A plain click ends with the pill unmoved, so nothing is saved.
  window.notchApi.drag('cancel');
  if (e.type === 'pointerup' && expandOn === 'click') {
    if (expanded) forceCollapse();
    else expand();
  }
}

barEl.addEventListener('pointerup', endGesture);
barEl.addEventListener('pointercancel', endGesture);
barEl.addEventListener('dblclick', () => window.notchApi.drag('reset'));

let lastWheelAt = 0;
barEl.addEventListener(
  'wheel',
  (e) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelAt < 220) return;
    lastWheelAt = now;
    cyclePill(d > 0 ? 1 : -1);
  },
  { passive: false }
);

function cyclePill(direction) {
  const current = plan.primary.kind === 'session' ? plan.primary.id : null;
  const next = window.NotchIsland.cycleSession(sessions, current, direction);
  if (!next) return;
  pickedId = next;
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => {
    pickedId = null;
    renderBar();
  }, PICK_RESET_MS);
  renderBar();
  const card = [...cards.querySelectorAll('.card')].find((c) => c.dataset.id === next);
  if (card && expanded) {
    card.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    card.classList.remove('featured');
    void card.offsetWidth;
    card.classList.add('featured');
  }
}

// Banner: click to act (open the session's terminal), swipe or scroll up to dismiss.
let bannerPress = null;
bannerEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  bannerPress = { y: e.screenY };
  bannerEl.setPointerCapture(e.pointerId);
});
bannerEl.addEventListener('pointerup', (e) => {
  if (!bannerPress) return;
  const dy = e.screenY - bannerPress.y;
  bannerPress = null;
  if (dy < -SWIPE_THRESHOLD) dismissBanner();
  else if (Math.abs(dy) < SWIPE_THRESHOLD) bannerAction();
});
bannerEl.addEventListener('pointercancel', () => (bannerPress = null));
bannerEl.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.deltaY < 0) dismissBanner();
  },
  { passive: false }
);

notch.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.notchApi.showMenu();
});

// While a request is waiting in the notch, keep the panel open so its buttons are visible.
let heldOpen = false;

window.notchApi.onUpdate((next) => {
  sessions = next;
  pruneApprovalBoxes();
  // The session being renamed ended: nothing to rename any more.
  if (renaming && !sessions.some((s) => s.id === renaming.id)) finishRename(false);
  if (pickedId && !sessions.some((s) => s.id === pickedId)) pickedId = null;
  render();
  const waiting = sessions.some((s) => (s.pendingApproval || s.pendingQuestion) && !s.muted);
  if (waiting && !heldOpen) {
    heldOpen = true;
    expand();
  } else if (!waiting && heldOpen) {
    heldOpen = false;
    if (!hovering) collapse();
  }
});

window.notchApi.onTransition((t) => {
  if (t.kind === 'done' || t.kind === 'error') flash(t.kind);
  if (t.kind === 'attention' && banner && banner.kind !== 'attention' && !cardBanners()) {
    // The pill shows the request itself; a "Done" toast must not cover it.
    bannerQueue = [];
    endBanner();
    return;
  }
  pushBanner(window.NotchIsland.bannerForTransition(t, sessions[0]));
});

// Screen reader announcements. The main process sends these to one notch window only, so a
// notch on every display doesn't repeat them.
const politeEl = document.getElementById('announce-polite');
const assertiveEl = document.getElementById('announce-assertive');

function announce(text, urgent) {
  const target = urgent ? assertiveEl : politeEl;
  // Clear first so the same message twice is still announced.
  target.textContent = '';
  setTimeout(() => (target.textContent = text), 50);
}

function describeTransition(t) {
  const s = t.session;
  switch (t.kind) {
    case 'attention':
      return s.status === 'approval'
        ? `${s.name} needs approval: ${s.label}. ${s.detail || ''}`
        : `${s.name} is waiting for your answer. ${s.detail || ''}`;
    case 'done':
      return `${s.name} finished.`;
    case 'error':
      return `${s.name} error: ${s.detail || 'unknown error'}`;
    default:
      return '';
  }
}

window.notchApi.onAnnounce((t) => {
  const text = describeTransition(t);
  if (text) announce(text, t.kind === 'attention' || t.kind === 'error');
});

// Keyboard mode: the pin hotkey focuses the notch. Arrows move between sessions, Enter opens
// the terminal, Shift+F10 / Menu key opens actions, Esc closes and returns to the previous app.
let keyboardMode = false;

window.notchApi.onKeyboard((active) => {
  keyboardMode = active;
  notch.classList.toggle('keyboard', active);
  // Keyboard focus ended some other way (hotkey, unpin): keep what was typed.
  if (!active && renaming) finishRename(true);
  if (active) {
    // Keyboard mode requested by clicking a text box in a question: type straight into it.
    if (pendingFocus && pendingFocus.isConnected) {
      pendingFocus.focus();
      if (renaming && pendingFocus === renaming.input) pendingFocus.select();
      pendingFocus = null;
      return;
    }
    pendingFocus = null;
    const first = cards.querySelector('[role="listitem"]');
    (first || pinButton).focus();
    announce(`${agentInfo(agent).label} sessions. ${sessions.length} live. Use arrow keys to move, Enter to open a terminal, Escape to close.`, false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'F2' && keyboardMode && !renaming) {
    const card = document.activeElement && document.activeElement.closest('.card');
    if (card) {
      e.preventDefault();
      startRename(card.dataset.id);
      return;
    }
  }
  if (e.key === 'Escape' && pinned) {
    e.preventDefault();
    window.notchApi.togglePin();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  if (e.target instanceof HTMLInputElement) return;
  const items = [...cards.querySelectorAll('[role="listitem"]')];
  if (!items.length) return;
  e.preventDefault();
  const current = items.indexOf(document.activeElement.closest('[role="listitem"]'));
  let next = current;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(items.length - 1, current + 1);
  else next = current < 0 ? 0 : Math.max(0, current - 1);
  items[next].focus();
  items[next].scrollIntoView({ block: 'nearest' });
});

let audioCtx = null;
let lastChimeAt = 0;
// Short two-note chime synthesised with WebAudio so no audio asset is needed.
function chime(kind) {
  // Several alerts can fire in the same second; one chime is enough.
  if (Date.now() - lastChimeAt < 1500) return;
  lastChimeAt = Date.now();
  try {
    audioCtx = audioCtx || new AudioContext();
    const notes =
      kind === 'done' ? [660, 880] : kind === 'timer' ? [988, 784, 988, 784] : kind && kind.startsWith('stuck') ? [440, 330] : [880, 1175];
    const start = audioCtx.currentTime + 0.01;
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = start + i * 0.14;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.35);
    });
  } catch (e) {
    console.warn('chime failed', e);
  }
}

window.notchApi.onChime(chime);

window.notchApi.getSessions().then((initial) => {
  sessions = initial || [];
  render();
});

function applySize(values) {
  zoom = SIZE_ZOOM[values && values.size] || 1;
  compact = !!(values && values.compactWhenIdle);
  align = (values && values.position) || 'center';
  const nextAgent = (values && values.agent) || 'copilot';
  const agentChanged = nextAgent !== agent;
  agent = nextAgent;
  notch.setAttribute('aria-label', `${agentInfo(agent).cli} sessions`);
  const root = document.documentElement;
  root.dataset.theme = (values && values.theme) || 'dark';
  root.style.setProperty('--bg-alpha', String(((values && values.opacity) || 100) / 100));
  document.body.dataset.align = align;
  const wasIsland = islandStyle;
  islandStyle = !values || values.islandStyle !== false;
  bannersOn = !values || values.islandBanners !== false;
  expandOn = (values && values.expandOn) || 'hover';
  features.media = !values || values.mediaControls !== false;
  features.shelf = !values || values.shelf !== false;
  features.battery = !values || values.batteryAlerts !== false;
  features.timer = !values || values.quickTimer !== false;
  document.body.classList.toggle('island-style', islandStyle);
  if (wasIsland !== islandStyle) lastShapeKey = '';
  renderBar();
  renderExtras();
  if (agentChanged) renderPanel();
}

window.notchApi.onEnded((list) => {
  ended = list || [];
  renderPanel();
});
window.notchApi.getEnded().then((list) => {
  ended = list || [];
  renderPanel();
});

window.notchApi.onSettings(applySize);
window.notchApi.getSettings().then(applySize);
window.addEventListener('resize', resize);
setInterval(tick, 1000);
setInterval(liveTick, 250);
initExtras();
