'use strict';

// Pure reducer that turns Copilot CLI events.jsonl entries into a session status.

const STALE_BETWEEN_TURNS_MS = 8000;
const RECENT_DONE_MS = 60000;

// Event types that drive status; if a session has events but none of these, the format has likely changed.
const CORE_EVENT_TYPES = new Set([
  'user.message',
  'assistant.turn_start',
  'assistant.message',
  'assistant.turn_end',
  'tool.execution_start',
  'tool.execution_complete',
]);

// Every event type observed from Copilot CLI so far; anything else is logged once so format changes are noticed.
const KNOWN_EVENT_TYPES = new Set([
  ...CORE_EVENT_TYPES,
  'abort',
  'external_tool.requested',
  'external_tool.completed',
  'hook.start',
  'hook.end',
  'human_response.recorded',
  'instruction.update',
  'permission.requested',
  'permission.completed',
  'permission.carriedForward',
  'permission.messageAuthorization',
  'permission.messageAuthorizationRead',
  'session.start',
  'session.resume',
  'session.shutdown',
  'session.error',
  'session.warning',
  'session.info',
  'session.model_change',
  'session.mode_changed',
  'session.mode_notice_delivered',
  'session.permissions_changed',
  'session.auto_mode_resolved',
  'session.binary_asset',
  'session.usage_record',
  'session.usage_checkpoint',
  'session.task_complete',
  'skill.invoked',
  'skill.context_delivered_ref',
  'subagent.started',
  'subagent.configured',
  'subagent.completed',
  'subagent.failed',
  'subagent.deselected',
  'system.message',
  'system.notification',
]);

function isKnownEventType(type) {
  return KNOWN_EVENT_TYPES.has(type) || type.startsWith('model.');
}

function createSessionState(id) {
  return {
    id,
    name: null,
    cwd: null,
    summary: null,
    model: null,
    cliVersion: null,
    busy: false,
    inTurn: false,
    busySince: null,
    lastToolRequests: 0,
    lastMessage: null,
    tools: new Map(),
    permissions: new Map(),
    agents: new Map(),
    finishedAgents: new Set(),
    agentHistory: [],
    files: new Map(),
    pendingEdits: new Map(),
    error: null,
    ended: false,
    completedAt: null,
    lastEventAt: null,
    usage: { premiumRequests: 0, checkpointPremium: 0, outputTokens: 0, contextTokens: 0, contextLimit: 0 },
    quota: null,
    lastPrompt: null,
    recent: [],
  };
}

const RECENT_LIMIT = 5;

// Most recent main-agent tool calls, newest first.
function recordToolDone(state, tool, at, ok) {
  state.recent.unshift({ title: tool.title, detail: tool.detail, since: tool.since, durationMs: Math.max(0, at - tool.since), ok });
  if (state.recent.length > RECENT_LIMIT) state.recent.length = RECENT_LIMIT;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Replays the part of a long log that is skipped on startup (older than the replayed tail):
// usage totals and edit-tool events only. It runs before the tail, so the tail's newer
// records still win for the context meter.
function applyHistoricalUsage(state, event) {
  const d = event.data || {};
  if (event.type === 'tool.execution_start') {
    noteEditStart(state, d, null);
    return;
  }
  if (event.type === 'tool.execution_complete') {
    noteEditComplete(state, d, ts(event));
    return;
  }
  if (event.type === 'session.usage_record' || event.type === 'session.usage_checkpoint') applyUsage(state, event, ts(event));
}

// Usage and quota are tracked for the whole session, including subagent calls.
function applyUsage(state, event, at) {
  const d = event.data || {};
  if (event.type === 'session.usage_record') {
    const u = d.usage || {};
    // Premium requests are billed per user-initiated call; agent follow-ups are free.
    if (u.initiator === 'user') state.usage.premiumRequests += num(u.cost);
    state.usage.outputTokens += num(u.outputTokens);
    if (!event.agentId && num(u.inputTokens) > 0) {
      state.usage.contextTokens = num(u.inputTokens);
      if (num(u.maxPromptTokens) > 0) state.usage.contextLimit = num(u.maxPromptTokens);
    }
    return true;
  }
  if (event.type === 'session.usage_checkpoint') {
    state.usage.checkpointPremium = Math.max(state.usage.checkpointPremium, num(d.totalPremiumRequests));
    return true;
  }
  if (event.type === 'model.model_call_success') {
    const q = d.quotaSnapshots && d.quotaSnapshots.premium_interactions;
    if (q && typeof q === 'object') {
      state.quota = {
        unlimited: !!q.isUnlimitedEntitlement,
        entitlement: num(q.entitlementRequests),
        used: num(q.usedRequests),
        remainingPercentage: num(q.remainingPercentage),
        overage: num(q.overage),
        resetDate: typeof q.resetDate === 'string' ? q.resetDate : null,
        at,
      };
    }
    return true;
  }
  return false;
}

function ts(event) {
  const t = Date.parse(event && event.timestamp);
  return Number.isFinite(t) ? t : Date.now();
}

function truncate(text, max = 160) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function basename(p) {
  if (!p) return '';
  return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
}

function describeTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'powershell':
    case 'bash':
    case 'shell':
      return truncate(a.description || a.command);
    case 'view':
    case 'edit':
    case 'create':
    case 'str_replace_editor':
      return basename(a.path);
    case 'grep':
    case 'rg':
    case 'glob':
      return truncate(a.pattern);
    case 'web_fetch':
      return truncate(a.url);
    case 'web_search':
      return truncate(a.query);
    case 'task':
      return truncate(a.description || a.name);
    case 'ask_user':
      return truncate(a.message || a.question);
    case 'skill':
      return truncate(a.skill);
    case 'sql':
      return truncate(a.description);
    default:
      return truncate(a.description || a.intent || a.query || a.path || '');
  }
}

function describePermission(req) {
  if (!req || typeof req !== 'object') return { kind: 'unknown', detail: '' };
  switch (req.kind) {
    case 'shell':
      return { kind: 'shell', detail: truncate(req.fullCommandText || req.intention, 220) };
    case 'write':
      return { kind: 'write', detail: basename(req.fileName || req.resolvedPath) };
    case 'read':
      return { kind: 'read', detail: truncate(req.path) };
    case 'url':
      return { kind: 'url', detail: truncate(req.url) };
    case 'custom-tool':
      return { kind: 'tool', detail: truncate(req.toolName) };
    case 'mcp':
      return { kind: 'mcp', detail: truncate(req.toolTitle || req.toolName) };
    default:
      return { kind: req.kind || 'unknown', detail: truncate(req.intention || req.extensionName || '') };
  }
}

function ensureAgent(state, agentId, at) {
  let agent = state.agents.get(agentId);
  if (!agent) {
    agent = { id: agentId, name: 'subagent', description: '', model: null, startedAt: at, toolCalls: 0, tools: new Map() };
    state.agents.set(agentId, agent);
  }
  return agent;
}

const AGENT_HISTORY_LIMIT = 5;
const FILES_LIMIT = 50;

// Files a tool call will create/edit/delete, from its arguments.
function editTargets(toolName, args) {
  if (toolName === 'apply_patch') {
    const patch = typeof args === 'string' ? args : args && (args.patch || args.input);
    if (typeof patch !== 'string') return [];
    const out = [];
    const re = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
    let m;
    while ((m = re.exec(patch))) {
      if (m[3]) out.push({ path: m[3].trim(), kind: 'created' });
      else out.push({ path: m[2].trim(), kind: m[1] === 'Add' ? 'created' : m[1] === 'Delete' ? 'deleted' : 'edited' });
    }
    return out;
  }
  const a = args && typeof args === 'object' ? args : {};
  const p = a.path || a.file_path || a.filePath;
  if (typeof p !== 'string' || !p) return [];
  if (toolName === 'create' || (toolName === 'str_replace_editor' && a.command === 'create')) return [{ path: p, kind: 'created' }];
  if (toolName === 'edit' || (toolName === 'str_replace_editor' && ['str_replace', 'insert'].includes(a.command))) {
    return [{ path: p, kind: 'edited' }];
  }
  return [];
}

// Remembers which files a tool call targets; applied only if the call succeeds.
function noteEditStart(state, d, agentName) {
  const targets = editTargets(d.toolName, d.arguments);
  if (targets.length) state.pendingEdits.set(d.toolCallId, { targets, agentName });
}

function noteEditComplete(state, d, at) {
  const pending = state.pendingEdits.get(d.toolCallId);
  if (!pending) return;
  state.pendingEdits.delete(d.toolCallId);
  if (d.success === false) return;
  for (const { path, kind } of pending.targets) {
    const key = path.toLowerCase();
    const prev = state.files.get(key);
    // A file created in this session stays "created" however often it is edited afterwards.
    const merged = kind === 'deleted' ? 'deleted' : prev && prev.kind === 'created' ? 'created' : kind;
    state.files.set(key, { path, kind: merged, edits: (prev ? prev.edits : 0) + 1, lastAt: at, by: pending.agentName || (prev && prev.by) || null });
  }
}

function clearActivity(state) {
  state.tools.clear();
  state.permissions.clear();
  state.busy = false;
  state.inTurn = false;
}

function markDone(state, at) {
  state.busy = false;
  state.inTurn = false;
  state.completedAt = at;
}

function applyEvent(state, event) {
  if (!event || typeof event.type !== 'string') return state;
  const at = ts(event);
  const d = event.data || {};
  state.lastEventAt = at;

  // Permission requests are surfaced regardless of which agent raised them.
  if (event.type === 'permission.requested') {
    const p = describePermission(d.permissionRequest);
    const agent = event.agentId ? state.agents.get(event.agentId) : null;
    state.permissions.set(d.requestId, { ...p, agentName: agent ? agent.name : null, since: at });
    return state;
  }
  if (event.type === 'permission.completed') {
    state.permissions.delete(d.requestId);
    return state;
  }

  if (applyUsage(state, event, at)) return state;

  if (event.type === 'subagent.started') {
    const agent = ensureAgent(state, event.agentId || d.toolCallId, at);
    agent.name = d.agentDisplayName || d.agentName || agent.name;
    agent.description = d.agentDescription || agent.description;
    agent.model = d.model || agent.model;
    agent.startedAt = at;
    return state;
  }
  if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
    const agentId = event.agentId || d.toolCallId;
    const agent = state.agents.get(agentId);
    state.agents.delete(agentId);
    state.finishedAgents.add(agentId);
    state.agentHistory.unshift({
      id: agentId,
      name: d.agentDisplayName || (agent && agent.name) || d.agentName || 'subagent',
      description: (agent && agent.description) || '',
      model: d.model || (agent && agent.model) || null,
      durationMs: Number.isFinite(d.durationMs) ? d.durationMs : agent ? Math.max(0, at - agent.startedAt) : 0,
      toolCalls: Number.isFinite(d.totalToolCalls) ? d.totalToolCalls : agent ? agent.toolCalls : 0,
      tokens: Number.isFinite(d.totalTokens) ? d.totalTokens : null,
      ok: event.type === 'subagent.completed',
      endedAt: at,
    });
    if (state.agentHistory.length > AGENT_HISTORY_LIMIT) state.agentHistory.length = AGENT_HISTORY_LIMIT;
    return state;
  }

  if (event.agentId) {
    if (event.type === 'tool.execution_complete') noteEditComplete(state, d, at);
    // Ignore trailing events from agents that already completed.
    if (state.finishedAgents.has(event.agentId)) return state;
    const creates = event.type === 'tool.execution_start' || event.type === 'assistant.turn_start';
    const agent = creates ? ensureAgent(state, event.agentId, at) : state.agents.get(event.agentId);
    if (!agent) return state;
    if (event.type === 'tool.execution_start') {
      agent.toolCalls++;
      agent.tools.set(d.toolCallId, {
        name: d.toolName,
        title: d.toolTitle || d.toolName,
        detail: describeTool(d.toolName, d.arguments),
        since: at,
      });
      noteEditStart(state, d, agent.name);
    } else if (event.type === 'tool.execution_complete') {
      agent.tools.delete(d.toolCallId);
    }
    return state;
  }

  switch (event.type) {
    case 'session.start':
    case 'session.resume':
      state.ended = false;
      if (d.context && d.context.cwd) state.cwd = d.context.cwd;
      if (d.selectedModel && d.selectedModel !== 'auto') state.model = d.selectedModel;
      if (d.copilotVersion || d.version) state.cliVersion = String(d.copilotVersion || d.version);
      clearActivity(state);
      break;
    case 'session.model_change':
      if (d.newModel) state.model = d.newModel;
      break;
    case 'user.message':
      state.busy = true;
      state.busySince = at;
      state.error = null;
      state.completedAt = null;
      state.lastToolRequests = 0;
      if (typeof d.content === 'string' && d.content.trim()) state.lastPrompt = truncate(d.content, 200);
      break;
    case 'assistant.turn_start':
      if (!state.busy) state.busySince = at;
      state.busy = true;
      state.inTurn = true;
      state.lastToolRequests = 0;
      break;
    case 'assistant.message':
      state.lastToolRequests = Array.isArray(d.toolRequests) ? d.toolRequests.length : 0;
      if (d.model) state.model = d.model;
      if (d.content) state.lastMessage = truncate(d.content, 240);
      break;
    case 'assistant.turn_end':
      state.inTurn = false;
      if (state.lastToolRequests === 0 && state.tools.size === 0) markDone(state, at);
      break;
    case 'tool.execution_start':
      state.tools.set(d.toolCallId, {
        name: d.toolName,
        title: d.toolTitle || d.toolName,
        detail: describeTool(d.toolName, d.arguments),
        since: at,
      });
      noteEditStart(state, d, null);
      break;
    case 'tool.execution_complete': {
      const tool = state.tools.get(d.toolCallId);
      state.tools.delete(d.toolCallId);
      noteEditComplete(state, d, at);
      if (tool) recordToolDone(state, tool, at, d.success !== false);
      if (tool && tool.name === 'task_complete') markDone(state, at);
      break;
    }
    case 'session.task_complete':
      markDone(state, at);
      break;
    case 'abort':
      clearActivity(state);
      state.completedAt = null;
      break;
    case 'session.error':
      clearActivity(state);
      state.error = truncate(d.message || d.errorType || 'Error');
      break;
    case 'session.shutdown':
      clearActivity(state);
      state.agents.clear();
      state.ended = true;
      break;
    default:
      break;
  }
  return state;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function deriveStatus(state, now = Date.now()) {
  if (state.ended) return { status: 'ended', label: 'Ended', detail: '' };

  if (state.permissions.size > 0) {
    const p = [...state.permissions.values()][0];
    const who = p.agentName ? `${p.agentName}: ` : '';
    return { status: 'approval', label: `Approve ${p.kind}`, detail: who + p.detail, since: p.since };
  }

  const ask = [...state.tools.values()].find((t) => t.name === 'ask_user');
  if (ask) return { status: 'input', label: 'Waiting for you', detail: ask.detail, since: ask.since };

  if (state.tools.size > 0) {
    const t = [...state.tools.values()].pop();
    if (t.name === 'task' && state.agents.size > 0) {
      return { status: 'agents', label: `${plural(state.agents.size, 'agent')} working`, detail: t.detail, since: t.since };
    }
    return { status: 'tool', label: t.title, detail: t.detail, since: t.since };
  }

  // After a tool turn ends the next turn starts within milliseconds; if nothing follows, the session went idle.
  const stalled = state.busy && !state.inTurn && state.lastEventAt != null && now - state.lastEventAt > STALE_BETWEEN_TURNS_MS;
  if (state.busy && !stalled) return { status: 'thinking', label: 'Thinking', detail: state.lastMessage || '', since: state.busySince };

  if (state.agents.size > 0) {
    return {
      status: 'agents',
      label: `${plural(state.agents.size, 'agent')} working`,
      detail: [...state.agents.values()].map((a) => a.name).join(', '),
    };
  }

  if (state.error) return { status: 'error', label: 'Error', detail: state.error };

  const recentlyDone = state.completedAt && now - state.completedAt < RECENT_DONE_MS;
  return { status: 'idle', label: recentlyDone ? 'Done' : 'Idle', detail: state.lastMessage || '', since: state.completedAt };
}

function snapshot(state, now = Date.now()) {
  const s = deriveStatus(state, now);
  const busy = ['approval', 'input', 'tool', 'thinking', 'agents'].includes(s.status);
  return {
    id: state.id,
    name: state.name || state.summary || `New session ${state.id.slice(0, 8)}`,
    cwd: state.cwd,
    model: state.model,
    cliVersion: state.cliVersion,
    usage: {
      premiumRequests: Math.max(state.usage.premiumRequests, state.usage.checkpointPremium),
      outputTokens: state.usage.outputTokens,
      contextTokens: state.usage.contextTokens,
      contextLimit: state.usage.contextLimit,
    },
    quota: state.quota,
    lastPrompt: state.lastPrompt,
    // Running tools first (newest first), then recently finished ones.
    activity: [
      ...[...state.tools.values()].reverse().map((t) => ({ title: t.title, detail: t.detail, since: t.since, running: true })),
      ...state.recent,
    ].slice(0, RECENT_LIMIT),
    status: s.status,
    label: s.label,
    detail: s.detail || '',
    since: s.since || null,
    busySince: busy ? state.busySince : null,
    lastEventAt: state.lastEventAt,
    agents: [...state.agents.values()].map((a) => {
      const tool = [...a.tools.values()].pop();
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        model: a.model,
        startedAt: a.startedAt,
        toolCalls: a.toolCalls,
        activity: tool ? `${tool.title}${tool.detail ? ' · ' + tool.detail : ''}` : 'Thinking',
      };
    }),
    agentHistory: state.agentHistory,
    files: {
      total: state.files.size,
      list: [...state.files.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, FILES_LIMIT),
    },
  };
}

module.exports = {
  createSessionState,
  applyEvent,
  deriveStatus,
  snapshot,
  describeTool,
  STALE_BETWEEN_TURNS_MS,
  KNOWN_EVENT_TYPES,
  CORE_EVENT_TYPES,
  isKnownEventType,
  applyHistoricalUsage,
  editTargets,
};
