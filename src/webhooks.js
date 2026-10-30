'use strict';

// Outgoing webhooks for alerts (e.g. to Slack, Teams workflows, Discord, or your own service).

const { agentLabel } = require('./agents');

const TIMEOUT_MS = 10000;

const EVENTS = {
  attention: { setting: 'webhookOnAttention', emoji: '🟠', verb: 'needs you' },
  'stuck-waiting': { setting: 'webhookOnStuck', emoji: '⏰', verb: 'is still waiting for you' },
  'stuck-tool': { setting: 'webhookOnStuck', emoji: '🐢', verb: 'may be stuck' },
  done: { setting: 'webhookOnDone', emoji: '✅', verb: 'finished' },
  error: { setting: 'webhookOnError', emoji: '🔴', verb: 'hit an error' },
  test: { setting: null, emoji: '🧪', verb: 'sent a test message' },
};

function shouldSend(kind, settings) {
  const spec = EVENTS[kind];
  if (!spec || !settings.webhookUrl) return false;
  return spec.setting === null || !!settings[spec.setting];
}

function folderOf(cwd) {
  return cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() || '' : '';
}

// JSON body. `text` suits Slack/Teams-style receivers and `content` suits Discord. Commands,
// file paths, folders and prompts are only included when `includeDetails` is on.
function buildPayload(kind, session, { includeDetails = false, now = Date.now() } = {}) {
  const spec = EVENTS[kind] || EVENTS.test;
  const s = session || {};
  const who = agentLabel(s.agent);
  const name = s.name || `${who} session`;
  let what = `${spec.verb}`;
  if (kind === 'attention') what = s.status === 'input' ? 'is waiting for your answer' : 'needs approval';
  const text = `${spec.emoji} ${who} ${what} — ${name}${includeDetails && s.detail ? `: ${s.detail}` : ''}`;
  const payload = {
    text,
    content: text,
    event: kind,
    agent: s.agent || 'copilot',
    session: { id: s.id || null, name },
    status: s.status || null,
    label: s.label || null,
    timestamp: new Date(now).toISOString(),
    source: 'copilot-notch',
  };
  if (includeDetails) {
    payload.detail = s.detail || null;
    payload.session.folder = folderOf(s.cwd) || null;
    payload.session.cwd = s.cwd || null;
  }
  return payload;
}

async function sendWebhook(url, payload, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'notch-picker' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status;
}

module.exports = { shouldSend, buildPayload, sendWebhook, EVENTS };
