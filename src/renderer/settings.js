'use strict';

const form = document.getElementById('form');
const statusEl = document.getElementById('status');
let statusTimer = null;

// What following each agent can and can't show (Copilot: everything, so no note).
const AGENT_NOTES = {
  claude:
    'Follows Claude Code sessions (~/.claude). Permission prompts and questions show as needing you; answer them in the terminal.',
  codex:
    "Follows Codex sessions (~/.codex). Codex doesn't log approval prompts, so a command awaiting approval shows as running. Sessions leave the list after 30 minutes without activity.",
  gemini:
    "Follows Gemini CLI sessions (~/.gemini). Gemini logs tools only once they finish and doesn't log approval prompts or the end of a turn, so “Done” appears after a few quiet seconds (up to 2 minutes when its last message announced more work) and a slow tool may look finished. Sessions leave the list after 30 minutes without activity.",
};

function showAgent(agent) {
  const note = document.getElementById('agent-note');
  note.textContent = AGENT_NOTES[agent] || '';
  note.parentElement.hidden = !AGENT_NOTES[agent];
  // Approving and answering from the notch works through a Copilot CLI hook.
  document.getElementById('approve-section').hidden = agent !== 'copilot';
  // WSL sessions are followed for Copilot CLI, and WSL only exists on Windows.
  document.getElementById('wsl-toggle').hidden = agent !== 'copilot' || !/Windows/.test(navigator.userAgent);
  // Now playing reads Windows' media session.
  document.getElementById('media-toggle').hidden = !/Windows/.test(navigator.userAgent);
  document.getElementById('media-colors-toggle').hidden = !/Windows/.test(navigator.userAgent);
}

// Lyrics need Now playing; their options show only while lyrics are on.
function showLyricsOptions(values) {
  const windows = /Windows/.test(navigator.userAgent);
  document.getElementById('lyrics-toggle').hidden = !windows || !values.mediaControls;
  for (const label of document.querySelectorAll('.lyrics-option')) label.hidden = !windows || !values.mediaControls || !values.mediaLyrics;
  // The priority only matters when lyrics show in the pill.
  if (!values.lyricsInPill) document.getElementById('lyrics-priority').hidden = true;
}

function flashStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1500);
}

// Lists (download folders) are edited as one text, separated by ';'.
function fieldValue(v) {
  return Array.isArray(v) ? v.join('; ') : v;
}

function fill(values) {
  for (const input of form.querySelectorAll('input[name], select[name]')) {
    if (!(input.name in values)) continue;
    // Don't overwrite a field the user is in the middle of typing.
    if (input === document.activeElement && ['number', 'text', 'url'].includes(input.type)) continue;
    if (input.type === 'checkbox') input.checked = !!values[input.name];
    else input.value = fieldValue(values[input.name]);
  }
  showAgent(values.agent);
  showLyricsOptions(values);
  syncNav();
  applySearch();
  if (window.PetSettings) window.PetSettings.fill(values);
}

// Sidebar: one page at a time, or every matching setting while searching.
const nav = document.getElementById('nav');
const content = document.getElementById('content');
const pages = [...document.querySelectorAll('.page')];
const searchInput = document.getElementById('search');
const noResults = document.getElementById('no-results');
const PAGE_KEY = 'settingsPage';

function showPage(id) {
  const target = pages.find((p) => p.dataset.page === id && !p.hidden) || pages[0];
  for (const page of pages) page.classList.toggle('active', page === target);
  for (const button of nav.querySelectorAll('button')) {
    if (button.dataset.page === target.dataset.page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  content.scrollTop = 0;
  try {
    localStorage.setItem(PAGE_KEY, target.dataset.page);
  } catch {}
}

// Pages hidden for the current agent or platform lose their sidebar entry too.
function syncNav() {
  for (const button of nav.querySelectorAll('button')) {
    const page = pages.find((p) => p.dataset.page === button.dataset.page);
    button.hidden = !page || page.hidden;
  }
  const active = pages.find((p) => p.classList.contains('active'));
  if (!active || active.hidden) showPage('general');
}

const normalize = (text) => text.replace(/\s+/g, ' ').toLowerCase();

function applySearch() {
  const query = normalize(searchInput.value).trim();
  document.body.classList.toggle('searching', !!query);
  let anyHit = false;
  for (const page of pages) {
    const pageHit = !!query && normalize(page.querySelector('h1').textContent).includes(query);
    let pageShown = false;
    for (const section of page.querySelectorAll('section')) {
      const sectionHit = pageHit || (!!query && normalize(section.querySelector('h2').textContent).includes(query));
      let sectionShown = false;
      for (const row of section.querySelectorAll(':scope > :not(h2)')) {
        const hit = !query || sectionHit || normalize(row.textContent).includes(query);
        row.classList.toggle('no-match', !hit);
        if (hit && !row.hidden) sectionShown = true;
      }
      section.classList.toggle('no-match', !sectionShown);
      if (sectionShown) pageShown = true;
    }
    page.classList.toggle('no-match', !!query && !pageShown);
    if (pageShown && !page.hidden) anyHit = true;
  }
  noResults.hidden = !query || anyHit;
}

nav.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-page]');
  if (!button) return;
  if (searchInput.value) {
    searchInput.value = '';
    applySearch();
  }
  showPage(button.dataset.page);
});

nav.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const buttons = [...nav.querySelectorAll('button:not([hidden])')];
  const i = buttons.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length];
  next.focus();
  next.click();
});

searchInput.addEventListener('input', () => {
  content.scrollTop = 0;
  applySearch();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  searchInput.value = '';
  applySearch();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

let savedPage = null;
try {
  savedPage = localStorage.getItem(PAGE_KEY);
} catch {}
// The window can be opened on a page (Pet settings… opens Desktop pets).
showPage(new URLSearchParams(location.search).get('page') || savedPage || 'general');
window.notchApi.onShowPage((id) => {
  searchInput.value = '';
  applySearch();
  showPage(id);
});

const hotkeyHelp = document.getElementById('hotkey-help');
const hotkeyHelpDefault = hotkeyHelp.innerHTML;

async function showHotkeyStatus() {
  const { accelerator, registered } = await window.notchApi.hotkeyStatus();
  const failed = accelerator && !registered;
  hotkeyHelp.classList.toggle('error', !!failed);
  if (failed) hotkeyHelp.textContent = `“${accelerator}” is invalid or already used by another app — try a different combination.`;
  else hotkeyHelp.innerHTML = hotkeyHelpDefault;
}

form.addEventListener('change', async (e) => {
  const input = e.target;
  if (!input.name) return;
  const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  const saved = await window.notchApi.setSettings(input.name === 'position' ? { position: value, offsetX: 0 } : { [input.name]: value });
  // Reflect clamping / rejected values back into the field.
  if (['number', 'text', 'url'].includes(input.type)) input.value = fieldValue(saved[input.name]);
  fill(saved);
  if (input.name === 'hotkey') await showHotkeyStatus();
  if (input.name === 'downloads') showExtensionStatus();
  if (input.name === 'downloadFolders' && value.trim() && !saved.downloadFolders.length) {
    flashStatus('Use full folder paths, such as D:\\Downloads');
    return;
  }
  if (input.name === 'updateFeedUrl' && value.trim() && !saved.updateFeedUrl) {
    flashStatus('Use an https:// URL (or http://localhost for testing)');
    return;
  }
  if (input.name === 'webhookUrl' && value.trim() && saved[input.name] !== normalizeUrl(value)) {
    flashStatus('Only https:// URLs are accepted');
    return;
  }
  flashStatus('Saved');
});

function normalizeUrl(value) {
  try {
    return new URL(value.trim()).toString();
  } catch {
    return null;
  }
}

form.addEventListener('submit', (e) => e.preventDefault());

// The browser extension reports while downloads run; the status shows which browsers did lately.
const extensionStatus = document.getElementById('extension-status');

async function showExtensionStatus() {
  const s = await window.notchApi.downloadsStatus();
  extensionStatus.classList.remove('ok', 'error');
  if (!s.on) extensionStatus.textContent = 'Browser downloads are off';
  else if (!s.port) {
    extensionStatus.textContent = 'The extension can’t connect: ports 47615–47617 are in use';
    extensionStatus.classList.add('error');
  } else if (s.browsers.length) {
    extensionStatus.textContent = `Connected: ${s.browsers.join(', ')}`;
    extensionStatus.classList.add('ok');
  } else extensionStatus.textContent = 'Once added, it connects when a download starts';
}

document.getElementById('open-extension').addEventListener('click', async () => {
  const result = await window.notchApi.openDownloadExtension();
  if (!result.ok) {
    extensionStatus.textContent = `Couldn’t open ${result.dir}: ${result.error}`;
    extensionStatus.classList.add('error');
  }
});

showExtensionStatus();
setInterval(showExtensionStatus, 5000);

document.getElementById('test').addEventListener('click', async () => {
  await window.notchApi.testNotification();
  flashStatus('Notification sent');
});

document.getElementById('test-webhook').addEventListener('click', async () => {
  const out = document.getElementById('webhook-status');
  out.textContent = 'Sending…';
  const result = await window.notchApi.testWebhook();
  out.textContent = result.detail;
  out.classList.toggle('error', !result.ok);
});

window.notchApi.onSettings(fill);
window.notchApi.getSettings().then(fill);
showHotkeyStatus();

const updateStatus = document.getElementById('update-status');
const installButton = document.getElementById('install-update');
const checkButton = document.getElementById('check-update');

function showUpdate({ state, text }) {
  updateStatus.textContent = text;
  updateStatus.classList.toggle('error', state.status === 'error');
  installButton.hidden = state.status !== 'ready';
  checkButton.disabled = state.status === 'disabled' || state.status === 'checking' || state.status === 'downloading';
}

checkButton.addEventListener('click', async () => {
  updateStatus.textContent = 'Checking for updates…';
  showUpdate(await window.notchApi.checkUpdate());
});
installButton.addEventListener('click', () => window.notchApi.installUpdate());
window.notchApi.onUpdateState(showUpdate);
window.notchApi.getUpdate().then(showUpdate);
