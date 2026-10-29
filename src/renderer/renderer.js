'use strict';

const BAR_HEIGHT = 24;
const MAX_HEIGHT = 340;
const EMPTY_WIDTH = 170;
const COLLAPSED_WIDTH = 260;
const EXPANDED_WIDTH = 380;
const COLLAPSE_DELAY_MS = 220;
const TOAST_MS = 4000;
const CODE_STATUSES = new Set(['approval', 'tool']);
const STATUS_CLASSES = ['idle', 'done', 'thinking', 'tool', 'agents', 'approval', 'input', 'error', 'stuck'].map((s) => `status-${s}`);

const notch = document.getElementById('notch');
const bar = {
  tag: notch.querySelector('.bar .bar-tag'),
  label: notch.querySelector('.bar .label'),
  detail: notch.querySelector('.bar .detail'),
  elapsed: notch.querySelector('.bar .elapsed'),
  dots: notch.querySelector('.bar .dots'),
};
const panel = notch.querySelector('.panel');
const cards = notch.querySelector('.cards');
const countEl = notch.querySelector('.panel-header .title');
const quotaEl = notch.querySelector('.panel-header .quota');
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
let collapseTimer = null;
let toast = null;
let toastTimer = null;
let flashTimer = null;

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
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`;
}

function renderBar() {
  const top = sessions[0];
  notch.classList.toggle('empty', !top && !toast);
  notch.classList.toggle('dot-only', window.NotchVisibility.isDotOnly({ compact, top, toast }));

  if (toast) {
    setStatusClass(notch, toast.kind === 'error' ? 'error' : 'done');
    notch.classList.remove('attention', 'overdue');
    bar.label.textContent = toast.kind === 'error' ? 'Error' : 'Done';
    bar.detail.textContent = toast.session.name;
    bar.elapsed.textContent = '';
    bar.elapsed.dataset.since = '';
  } else if (!top) {
    setStatusClass(notch, 'idle');
    notch.classList.remove('attention', 'overdue');
    bar.label.textContent = 'Copilot';
    bar.detail.textContent = 'no live sessions';
    bar.elapsed.textContent = '';
    bar.elapsed.dataset.since = '';
  } else {
    const vs = visualStatus(top);
    setStatusClass(notch, vs);
    const alerting = (vs === 'approval' || vs === 'input') && !top.muted;
    notch.classList.toggle('attention', alerting);
    notch.classList.toggle('overdue', alerting && top.stuck === 'waiting');
    bar.label.textContent = displayLabel(top);
    bar.detail.textContent = top.detail || top.name;
    const since = top.status === 'idle' ? null : top.busySince || top.since;
    bar.elapsed.dataset.since = since || '';
    bar.elapsed.textContent = formatElapsed(since);
  }

  // Colour tag of the session the pill is showing, so you can tell which one it is.
  const shown = toast ? toast.session : top;
  const tag = shown && shown.tag;
  bar.tag.hidden = !tag;
  bar.tag.className = tag ? `bar-tag tag-${tag}` : 'bar-tag';
  bar.tag.title = tag ? shown.name : '';

  bar.dots.replaceChildren();
  if (sessions.length > 1) {
    for (const s of sessions) {
      const dot = el('i');
      setStatusClass(dot, visualStatus(s));
      dot.classList.toggle('muted', !!s.muted);
      if (s.tag) dot.classList.add('tagged', `tag-${s.tag}`);
      dot.title = `${s.name}: ${displayLabel(s)}${s.muted ? ' (muted)' : ''}`;
      bar.dots.append(dot);
    }
  }
  resize();
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
    if (s.originalName) name.title = `Your name for this session. Copilot calls it: ${s.originalName}`;
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
  if (s.cwd) {
    const cwd = el('span', null, `📁 ${shortPath(s.cwd)}`);
    cwd.title = s.cwd;
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
  return { name, dir: shortPath(parts.join('\\')) };
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
    model.title = s.cliVersion ? `${s.model} · Copilot CLI v${s.cliVersion}` : s.model;
    row.append(model);
  }
  if (!u || (!u.premiumRequests && !u.outputTokens && !u.contextLimit)) {
    if (s.cliVersion) row.append(el('span', 'version', `v${s.cliVersion}`));
    return row.childElementCount ? row : null;
  }
  const premium = el('span', null, `⚡ ${u.premiumRequests}`);
  premium.title = `${u.premiumRequests} premium requests used by this session`;
  row.append(premium);
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
  const live = sessions.length ? sessions.map(renderCard) : [el('div', 'empty-card', 'Start `copilot` in a terminal to see it here.')];
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
  const width = expanded
    ? EXPANDED_WIDTH
    : notch.classList.contains('dot-only')
      ? DOT_WIDTH
      : notch.classList.contains('empty')
        ? EMPTY_WIDTH
        : COLLAPSED_WIDTH;
  const height = expanded ? Math.min(MAX_HEIGHT, BAR_HEIGHT + panel.scrollHeight) : BAR_HEIGHT;
  notch.style.width = `${width}px`;
  notch.style.height = `${height}px`;
  notch.style.zoom = String(zoom);
  // Approval buttons stay disarmed until the shape has settled (see renderApproval).
  if (width !== lastShape.width || zoom !== lastShape.zoom) layoutChangedAt = Date.now();
  lastShape = { width, zoom };
  // Report the target bounds (not the animating ones) so hover tracking matches the final shape.
  const w = width * zoom;
  const x = align === 'left' ? 0 : align === 'right' ? window.innerWidth - w : (window.innerWidth - w) / 2;
  window.notchApi.reportRect({ x, y: 0, width: w, height: height * zoom });
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

function expand() {
  clearTimeout(collapseTimer);
  if (expanded) return;
  expanded = true;
  notch.classList.add('expanded');
  resize();
}

function collapse() {
  clearTimeout(collapseTimer);
  if (pinned || heldOpen) return;
  collapseTimer = setTimeout(() => {
    expanded = false;
    notch.classList.remove('expanded');
    resize();
  }, COLLAPSE_DELAY_MS);
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

window.notchApi.onHover((value) => {
  hovering = value;
  if (value) expand();
  else collapse();
});

pinButton.addEventListener('click', (e) => {
  e.stopPropagation();
  window.notchApi.togglePin();
});
window.notchApi.onPinned(setPinned);
window.notchApi.getPinned().then(setPinned);

// Drag the pill sideways by its top bar; double-click the bar to snap back.
const DRAG_THRESHOLD = 4;
const barEl = notch.querySelector('.bar');
let drag = null;

barEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { startX: e.screenX, moved: false, frame: 0 };
  barEl.setPointerCapture(e.pointerId);
  // The main process measures from the cursor position at this moment.
  window.notchApi.drag('start');
});

barEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.abs(e.screenX - drag.startX) < DRAG_THRESHOLD) return;
    drag.moved = true;
    notch.classList.add('dragging');
  }
  // Coalesce to one window move per frame.
  if (!drag.frame) {
    drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      window.notchApi.drag('move');
    });
  }
});

function endDrag() {
  if (!drag) return;
  if (drag.frame) cancelAnimationFrame(drag.frame);
  // A plain click ends with the pill unmoved, so nothing is saved.
  window.notchApi.drag(drag.moved ? 'end' : 'cancel');
  notch.classList.remove('dragging');
  drag = null;
}

barEl.addEventListener('pointerup', endDrag);
barEl.addEventListener('pointercancel', endDrag);
barEl.addEventListener('dblclick', () => window.notchApi.drag('reset'));

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
  if (t.kind === 'done' || t.kind === 'error') {
    flash(t.kind);
    // Show the toast unless another session needs attention.
    const top = sessions[0];
    if (!top || top.id === t.session.id || (top.status !== 'approval' && top.status !== 'input')) {
      toast = t;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast = null;
        renderBar();
      }, TOAST_MS);
      renderBar();
    }
  } else if (t.kind === 'attention') {
    toast = null;
    renderBar();
  }
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
    announce(`Copilot sessions. ${sessions.length} live. Use arrow keys to move, Enter to open a terminal, Escape to close.`, false);
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
    const notes = kind === 'done' ? [660, 880] : kind && kind.startsWith('stuck') ? [440, 330] : [880, 1175];
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
  const root = document.documentElement;
  root.dataset.theme = (values && values.theme) || 'dark';
  root.style.setProperty('--bg-alpha', String(((values && values.opacity) || 100) / 100));
  document.body.dataset.align = align;
  renderBar();
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
