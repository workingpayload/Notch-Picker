'use strict';

const form = document.getElementById('form');
const statusEl = document.getElementById('status');
let statusTimer = null;

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
