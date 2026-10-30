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
}

function flashStatus(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ''), 1500);
}

function fill(values) {
  for (const input of form.querySelectorAll('input[name], select[name]')) {
    if (!(input.name in values)) continue;
    // Don't overwrite a field the user is in the middle of typing.
    if (input === document.activeElement && ['number', 'text', 'url'].includes(input.type)) continue;
    if (input.type === 'checkbox') input.checked = !!values[input.name];
    else input.value = values[input.name];
  }
  showAgent(values.agent);
}

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
  if (['number', 'text', 'url'].includes(input.type)) input.value = saved[input.name];
  fill(saved);
  if (input.name === 'hotkey') await showHotkeyStatus();
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

document.getElementById('pet-settings').addEventListener('click', () => window.notchApi.openPetSettings());

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
