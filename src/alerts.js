'use strict';

// Decides when a session deserves a desktop notification or a "stuck" warning.
// Pure (no Electron) so it can be unit tested.

const ATTENTION = new Set(['approval', 'input']);

function stuckKind(session, now, settings) {
  if (!session.since) return null;
  const waited = now - session.since;
  if (ATTENTION.has(session.status) && waited >= settings.stuckApprovalMinutes * 60000) return 'waiting';
  if (session.status === 'tool' && waited >= settings.stuckToolMinutes * 60000) return 'tool';
  return null;
}

class AlertTracker {
  constructor() {
    this.fired = new Set();
  }

  // Returns alerts to show now; each (session, state, since, kind) fires at most once.
  update(sessions, now, settings) {
    const alerts = [];
    const live = new Set();
    for (const s of sessions) {
      const base = `${s.id}|${s.status}|${s.since || 0}`;
      if (ATTENTION.has(s.status) && s.since && now - s.since >= settings.notifyDelaySeconds * 1000) {
        const key = `${base}|attention`;
        live.add(key);
        if (!this.fired.has(key)) {
          this.fired.add(key);
          alerts.push({ kind: 'attention', session: s });
        }
      }
      const stuck = stuckKind(s, now, settings);
      if (stuck) {
        const key = `${base}|stuck`;
        live.add(key);
        if (!this.fired.has(key)) {
          this.fired.add(key);
          alerts.push({ kind: stuck === 'tool' ? 'stuck-tool' : 'stuck-waiting', session: s });
        }
      }
    }
    // Forget keys for states that ended so memory doesn't grow.
    for (const key of this.fired) if (!live.has(key)) this.fired.delete(key);
    // An overdue reminder already covers the plain attention alert; don't double-notify.
    const overdue = new Set(alerts.filter((a) => a.kind === 'stuck-waiting').map((a) => a.session.id));
    return alerts.filter((a) => !(a.kind === 'attention' && overdue.has(a.session.id)));
  }
}

function minutes(ms) {
  const m = Math.round(ms / 60000);
  return `${m} min`;
}

function describeAlert(alert, now = Date.now()) {
  const s = alert.session;
  const where = s.name || 'Copilot session';
  switch (alert.kind) {
    case 'attention':
      return {
        title: s.status === 'approval' ? `Copilot needs approval — ${where}` : `Copilot is waiting for you — ${where}`,
        body: s.detail || s.label,
      };
    case 'stuck-waiting':
      return { title: `Still waiting for you (${minutes(now - s.since)}) — ${where}`, body: s.detail || s.label };
    case 'stuck-tool':
      return { title: `Possibly stuck: ${s.label} for ${minutes(now - s.since)} — ${where}`, body: s.detail || '' };
    case 'done':
      return { title: `Copilot finished — ${where}`, body: s.detail || '' };
    case 'error':
      return { title: `Copilot error — ${where}`, body: s.detail || '' };
    default:
      return { title: where, body: s.label || '' };
  }
}

module.exports = { AlertTracker, stuckKind, describeAlert };
