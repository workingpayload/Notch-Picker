'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const { parseWorkspaceYaml } = require('./watcher');

const DAY_MS = 24 * 60 * 60 * 1000;

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Summarises one session's events.jsonl: per-day premium requests, output tokens and prompts,
// plus premium requests per model. Only usage and prompt lines are parsed.
async function summarizeSession(dir) {
  const id = path.basename(dir);
  const summary = { id, name: null, cwd: null, days: {}, first: null, last: null };
  try {
    const ws = parseWorkspaceYaml(await fsp.readFile(path.join(dir, 'workspace.yaml'), 'utf8'));
    summary.name = ws.name || ws.summary || null;
    summary.cwd = ws.cwd || null;
  } catch {
    // optional
  }
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) return summary;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const isUsage = line.includes('"session.usage_record"');
    const isPrompt = !isUsage && line.includes('"user.message"');
    if (!isUsage && !isPrompt) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at)) continue;
    const day = (summary.days[localDay(at)] ||= { premium: 0, outputTokens: 0, prompts: 0, models: {} });
    summary.first = summary.first == null ? at : Math.min(summary.first, at);
    summary.last = summary.last == null ? at : Math.max(summary.last, at);
    if (e.type === 'user.message' && !e.agentId) {
      day.prompts++;
    } else if (e.type === 'session.usage_record') {
      const u = (e.data && e.data.usage) || {};
      day.outputTokens += num(u.outputTokens);
      if (u.initiator === 'user') {
        day.premium += num(u.cost);
        const model = u.modelDisplayName || u.model || 'unknown';
        day.models[model] = (day.models[model] || 0) + num(u.cost);
      }
    }
  }
  return summary;
}

// Scans every session folder, re-reading only logs whose size or mtime changed since last time.
class UsageCollector {
  constructor(root) {
    this.root = root;
    this.cache = new Map(); // id -> { key, summary }
  }

  async collect() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(this.root, e.name);
      const stat = await fsp.stat(path.join(dir, 'events.jsonl')).catch(() => null);
      const key = stat ? `${stat.size}:${stat.mtimeMs}` : 'none';
      const hit = this.cache.get(e.name);
      if (hit && hit.key === key) {
        out.push(hit.summary);
        continue;
      }
      const summary = await summarizeSession(dir);
      this.cache.set(e.name, { key, summary });
      out.push(summary);
    }
    return out;
  }
}

function folderName(cwd) {
  if (!cwd) return '(unknown folder)';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('\\') || cwd;
}

// Totals over the last `days` local days (including today).
function aggregate(summaries, { days = 7, now = Date.now() } = {}) {
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(localDay(now - i * DAY_MS));
  const inRange = new Set(dayKeys);
  const daily = Object.fromEntries(dayKeys.map((d) => [d, { day: d, premium: 0, outputTokens: 0, prompts: 0, sessions: 0 }]));
  const totals = { premium: 0, outputTokens: 0, prompts: 0, sessions: 0 };
  const folders = new Map();
  const models = new Map();
  const sessions = [];

  for (const s of summaries) {
    let premium = 0;
    let prompts = 0;
    let outputTokens = 0;
    for (const [day, v] of Object.entries(s.days)) {
      if (!inRange.has(day)) continue;
      const d = daily[day];
      d.premium += v.premium;
      d.outputTokens += v.outputTokens;
      d.prompts += v.prompts;
      d.sessions++;
      premium += v.premium;
      prompts += v.prompts;
      outputTokens += v.outputTokens;
      for (const [model, value] of Object.entries(v.models || {})) models.set(model, (models.get(model) || 0) + value);
    }
    if (!premium && !prompts && !outputTokens) continue;
    totals.premium += premium;
    totals.prompts += prompts;
    totals.outputTokens += outputTokens;
    totals.sessions++;
    const folder = folderName(s.cwd);
    const f = folders.get(folder) || { folder, cwd: s.cwd, premium: 0, sessions: 0 };
    f.premium += premium;
    f.sessions++;
    folders.set(folder, f);
    sessions.push({ id: s.id, name: s.name || s.id.slice(0, 8), cwd: s.cwd, premium, prompts, last: s.last });
  }

  const byPremium = (a, b) => b.premium - a.premium;
  return {
    days,
    totals,
    daily: dayKeys.map((d) => daily[d]),
    folders: [...folders.values()].sort(byPremium).slice(0, 8),
    models: [...models.entries()]
      .map(([model, premium]) => ({ model, premium: Math.round(premium * 10) / 10 }))
      .filter((m) => m.premium > 0)
      .sort(byPremium),
    sessions: sessions.sort(byPremium).slice(0, 8),
  };
}

module.exports = { UsageCollector, summarizeSession, aggregate, localDay };
