'use strict';

// Translates Claude Code, Codex and Gemini CLI session logs into the Copilot CLI event shapes that
// session-state.js understands, so every agent shares one status model. Each translator takes one
// parsed log record plus a per-session context (newContext) and returns zero or more events.

// Pseudo-event carrying session metadata (name/summary); applied by the tracker, not the reducer.
const META = 'notch.meta';

function newContext() {
  return { started: false, lastTs: null, model: null, messages: new Map(), seen: new Map(), totalOut: 0, pendingFinal: false };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Text of a string, a list of text parts ({text}) or a single part.
function partsText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

function remember(map, key, value, limit = 300) {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
  return value;
}

function emitter(out, timestamp) {
  return (type, data = {}, at = timestamp) => out.push({ type, timestamp: at, data });
}

function modelChange(ctx, ev, model) {
  if (!model || model === ctx.model) return;
  ctx.model = model;
  ev('session.model_change', { newModel: model });
}

// ---- Tool names ----
// Maps each agent's tools onto the names session-state.js knows (shell, view, edit, create,
// apply_patch, grep, glob, web_fetch, web_search, task, ask_user) so details and changed files work.

function tool(toolName, toolTitle, args) {
  return { toolName, toolTitle, arguments: args };
}

function firstQuestion(a) {
  const q = Array.isArray(a.questions) ? a.questions[0] : null;
  return str(q && (q.question || q.header)) || str(a.question) || str(a.message);
}

function mcpTitle(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2]}` : name;
}

function claudeTool(name, input) {
  const a = input && typeof input === 'object' ? input : {};
  const file = a.file_path || a.notebook_path || a.path;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return tool('shell', name, { command: a.command, description: a.description });
    case 'Read':
      return tool('view', name, { path: file });
    case 'Write':
      return tool('create', name, { path: file });
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return tool('edit', name, { path: file });
    case 'Grep':
      return tool('grep', name, { pattern: a.pattern });
    case 'Glob':
      return tool('glob', name, { pattern: a.pattern });
    case 'WebFetch':
      return tool('web_fetch', name, { url: a.url });
    case 'WebSearch':
      return tool('web_search', name, { query: a.query });
    case 'Task':
    case 'Agent':
      return tool('task', 'Agent', { description: a.description || a.subagent_type });
    case 'AskUserQuestion':
      return tool('ask_user', 'Question', { question: firstQuestion(a) });
    default:
      return tool(name, mcpTitle(name), a);
  }
}

function shellText(command) {
  return Array.isArray(command) ? command.join(' ') : str(command);
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Codex's code-mode "exec" tool runs JavaScript that usually wraps one shell command.
function execSummary(code) {
  const m = /["']?\bcommand["']?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(code);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  return code.split('\n').find((l) => l.trim()) || '';
}

function codexTool(p) {
  const name = str(p.name);
  if (p.type === 'local_shell_call') return tool('shell', 'Shell', { command: shellText(p.action && p.action.command) });
  if (p.type === 'web_search_call') return tool('web_search', 'Web search', { query: str(p.action && p.action.query) });
  if (name === 'apply_patch') return tool('apply_patch', 'Apply patch', typeof p.input === 'string' ? p.input : parseArgs(p.arguments));
  if (name === 'exec' && typeof p.input === 'string') return tool('shell', 'Shell', { command: execSummary(p.input) });
  const a = parseArgs(p.arguments);
  switch (name) {
    case 'shell':
    case 'shell_command':
    case 'exec_command':
    case 'container.exec':
      return tool('shell', 'Shell', { command: shellText(a.command || a.cmd) });
    case 'update_plan':
      return tool('update_plan', 'Update plan', { description: a.explanation });
    case 'view_image':
      return tool('view', 'View image', { path: a.path });
    case 'request_user_input':
      return tool('ask_user', 'Question', { question: firstQuestion(a) });
    case 'spawn_agent':
      return tool('task', 'Agent', { description: a.agent_type || a.message });
    default: {
      const ns = str(p.namespace).replace(/^mcp__/, '');
      return tool(name, ns ? `${ns}: ${name}` : name, { description: a.title || a.description, query: a.query, path: a.path });
    }
  }
}

function geminiTool(name, args, displayName) {
  const a = args && typeof args === 'object' ? args : {};
  const title = str(displayName) || name;
  const file = a.file_path || a.absolute_path || a.path;
  switch (name) {
    case 'run_shell_command':
      return tool('shell', title, { command: a.command, description: a.description });
    case 'read_file':
      return tool('view', title, { path: file });
    case 'read_many_files': {
      const list = a.paths || a.include;
      return tool('view', title, { path: Array.isArray(list) ? list[0] : list });
    }
    case 'list_directory':
      return tool('view', title, { path: a.dir_path || a.path });
    case 'write_file':
      return tool('create', title, { path: file });
    case 'replace':
    case 'edit':
      return tool('edit', title, { path: file });
    case 'glob':
      return tool('glob', title, { pattern: a.pattern });
    case 'search_file_content':
    case 'grep_search':
      return tool('grep', title, { pattern: a.pattern });
    case 'web_fetch':
      return tool('web_fetch', title, { url: a.url || a.prompt });
    case 'google_web_search':
      return tool('web_search', title, { query: a.query });
    case 'ask_user':
      return tool('ask_user', title, { question: firstQuestion(a) });
    default:
      return tool(name, title, a);
  }
}

// ---- Claude Code: ~/.claude/projects/<folder>/<session>.jsonl ----

const CLAUDE_TURN_END = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
// Slash commands, shell escapes and injected reminders are logged as user text but aren't prompts.
const CLAUDE_NOT_A_PROMPT = /^<(command-|local-command|bash-|system-reminder|user-memory|task-notification)/;

function claudeEvents(rec, ctx) {
  const out = [];
  if (!rec || typeof rec !== 'object' || rec.isSidechain) return out;
  if (rec.timestamp) ctx.lastTs = rec.timestamp;
  const ev = emitter(out, rec.timestamp || ctx.lastTs || undefined);
  if (!ctx.started && typeof rec.cwd === 'string' && (rec.type === 'user' || rec.type === 'assistant')) {
    ctx.started = true;
    ev('session.start', { context: { cwd: rec.cwd }, version: rec.version });
  }
  if (rec.type === 'summary' && rec.summary) ev(META, { summary: String(rec.summary) });
  if (rec.type === 'custom-title' && rec.customTitle) ev(META, { name: String(rec.customTitle) });
  const m = rec.message;
  if (!m || typeof m !== 'object') return out;

  if (rec.type === 'user') {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b && b.type === 'tool_result') ev('tool.execution_complete', { toolCallId: b.tool_use_id, success: !b.is_error });
    }
    if (rec.isMeta || rec.isCompactSummary) return out;
    const text = blocks
      .filter((b) => b && b.type === 'text')
      .map((b) => str(b.text))
      .join('\n')
      .trim();
    if (!text) return out;
    if (/^\[Request interrupted by user/.test(text)) ev('abort');
    else if (!CLAUDE_NOT_A_PROMPT.test(text)) {
      // Replies are only logged once complete, so the turn starts with the prompt.
      ev('user.message', { content: text });
      ev('assistant.turn_start');
    }
    return out;
  }

  if (rec.type === 'assistant') {
    if (rec.isApiErrorMessage) {
      ev('session.error', { message: partsText(m.content) || str(rec.error) || 'API error' });
      return out;
    }
    // Each content block is its own line, repeating the message id and usage.
    const id = m.id || rec.uuid;
    let seen = ctx.messages.get(id);
    if (!seen) {
      seen = remember(ctx.messages, id, { out: 0 });
      ev('assistant.turn_start');
    }
    if (m.model !== '<synthetic>') modelChange(ctx, ev, m.model);
    const u = m.usage;
    if (u && typeof u === 'object') {
      const outTokens = num(u.output_tokens);
      const delta = Math.max(0, outTokens - seen.out);
      seen.out = Math.max(seen.out, outTokens);
      const context = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      ev('session.usage_record', { usage: { outputTokens: delta, inputTokens: context } });
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b) continue;
      if (b.type === 'text' && b.text) ev('assistant.message', { content: b.text });
      else if (b.type === 'tool_use') ev('tool.execution_start', { toolCallId: b.id, ...claudeTool(b.name, b.input) });
    }
    if (CLAUDE_TURN_END.has(m.stop_reason)) ev('assistant.turn_end');
  }
  return out;
}

// ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----

// Codex wraps context (environment, AGENTS.md, aborted-turn notes) in user messages too.
function codexPrompt(content) {
  const text = (Array.isArray(content) ? content : [])
    .filter((c) => c && (c.type === 'input_text' || c.type === 'text'))
    .map((c) => str(c.text))
    .join('\n')
    .trim();
  if (!text || text.startsWith('<') || text.startsWith('# AGENTS.md')) return '';
  return text;
}

function codexOutputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((o) => (o && typeof o.text === 'string' ? o.text : '')).join('\n');
  if (output && typeof output === 'object') return str(output.content) || JSON.stringify(output);
  return '';
}

function codexSuccess(output) {
  const text = codexOutputText(output);
  try {
    const j = JSON.parse(text);
    if (j && j.metadata && Number.isFinite(j.metadata.exit_code)) return j.metadata.exit_code === 0;
  } catch {
    // plain text output
  }
  const m = /Exit code:\s*(-?\d+)/i.exec(text) || /Process exited with code (-?\d+)/i.exec(text);
  return m ? Number(m[1]) === 0 : true;
}

// Codex runs subagents as their own threads; they belong to the parent session.
function isCodexSubagent(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const src = meta.source;
  if (src && typeof src === 'object' && ('subagent' in src || 'sub_agent' in src)) return true;
  return /sub_?agent/i.test(str(meta.thread_source));
}

function cleanCwd(cwd) {
  return str(cwd).replace(/^\\\\\?\\/, '') || null;
}

function codexEvents(rec, ctx) {
  const out = [];
  if (!rec || typeof rec !== 'object') return out;
  if (rec.timestamp) ctx.lastTs = rec.timestamp;
  const ev = emitter(out, rec.timestamp || ctx.lastTs || undefined);
  const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};

  if (rec.type === 'session_meta') {
    if (!ctx.started) {
      ctx.started = true;
      ev('session.start', { context: { cwd: cleanCwd(p.cwd) }, version: p.cli_version });
    }
    return out;
  }
  if (rec.type === 'turn_context') {
    modelChange(ctx, ev, p.model);
    return out;
  }
  if (rec.type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
      case 'turn_started':
        ev('user.message', {});
        ev('assistant.turn_start');
        if (num(p.model_context_window)) ctx.contextWindow = p.model_context_window;
        break;
      case 'user_message': {
        const text = str(p.message).trim();
        if (text && !text.startsWith('<')) ev('user.message', { content: text });
        break;
      }
      case 'agent_message':
        if (p.message) ev('assistant.message', { content: str(p.message) });
        break;
      case 'task_complete':
      case 'turn_complete':
        if (p.last_agent_message) ev('assistant.message', { content: str(p.last_agent_message) });
        ev('assistant.turn_end');
        ev('session.task_complete');
        break;
      case 'turn_aborted':
        ev('abort');
        break;
      case 'error':
        ev('session.error', { message: str(p.message) || 'Error' });
        break;
      case 'token_count': {
        const info = p.info;
        if (!info || typeof info !== 'object') break;
        const total = info.total_token_usage || {};
        const last = info.last_token_usage || {};
        const totalOut = num(total.output_tokens);
        const delta = Math.max(0, totalOut - ctx.totalOut);
        ctx.totalOut = Math.max(ctx.totalOut, totalOut);
        ev('session.usage_record', {
          usage: { outputTokens: delta, inputTokens: num(last.input_tokens), maxPromptTokens: num(info.model_context_window) || num(ctx.contextWindow) },
        });
        break;
      }
      // Approval prompts, when a Codex version writes them to the rollout.
      case 'exec_approval_request':
        ev('permission.requested', {
          requestId: p.call_id || p.id,
          permissionRequest: { kind: 'shell', fullCommandText: shellText(p.command), intention: p.reason },
        });
        break;
      case 'apply_patch_approval_request':
        ev('permission.requested', {
          requestId: p.call_id || p.id,
          permissionRequest: { kind: 'write', fileName: Object.keys(p.changes || {})[0] || '' },
        });
        break;
      case 'exec_command_begin':
      case 'patch_apply_begin':
        ev('permission.completed', { requestId: p.call_id || p.id });
        break;
      default:
        break;
    }
    return out;
  }
  if (rec.type === 'response_item') {
    switch (p.type) {
      case 'message':
        if (p.role === 'user') {
          const text = codexPrompt(p.content);
          if (text) ev('user.message', { content: text });
        } else if (p.role === 'assistant') {
          const text = partsText(p.content).trim();
          if (text) ev('assistant.message', { content: text });
        }
        break;
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
        ev('tool.execution_start', { toolCallId: p.call_id || p.id, ...codexTool(p) });
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        ev('tool.execution_complete', { toolCallId: p.call_id || p.id, success: codexSuccess(p.output) });
        break;
      case 'web_search_call': {
        const id = p.id || p.call_id || `web-${ctx.lastTs}`;
        ev('tool.execution_start', { toolCallId: id, ...codexTool(p) });
        ev('tool.execution_complete', { toolCallId: id, success: p.status !== 'failed' });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ---- Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl (or legacy .json) ----
// Messages are re-appended whenever they change (upsert by id). Tool calls are only written once
// they finish, and a turn's end isn't logged: a text-only reply sets `pendingFinal`, which the
// tracker confirms as "done" once the log has been quiet for a moment. Replies announcing more
// work ("I will read…") are usually followed by tools, so `preamble` asks for a longer wait.

const GEMINI_PREAMBLE =
  /^(?:\*\*[^*\n]{1,80}\*\*\s*)?(?:I will|I'll|I am going to|I'm going to|Let me|Let's|First,|Next,|Now,? I|Okay,? I|OK,? I|Alright,? I|I need to|I should|I'm now|I am now|I'm (?:going|about) to|I am (?:analy[sz]ing|checking|reading|looking|searching|investigating|examining|reviewing|updating|creating|running|starting))/i;

function geminiEvents(rec, ctx) {
  const out = [];
  if (!rec || typeof rec !== 'object') return out;
  if (rec.$set && typeof rec.$set === 'object') {
    if (rec.$set.summary) out.push({ type: META, timestamp: ctx.lastTs || undefined, data: { summary: String(rec.$set.summary) } });
    return out;
  }
  if (rec.$rewindTo) return out;
  // Metadata line (JSONL) or the whole legacy JSON file.
  if (!rec.type && rec.sessionId) {
    if (rec.summary) out.push({ type: META, timestamp: ctx.lastTs || undefined, data: { summary: String(rec.summary) } });
    if (Array.isArray(rec.messages)) for (const msg of rec.messages) out.push(...geminiEvents(msg, ctx));
    return out;
  }
  const id = rec.id;
  if (!id || typeof rec.type !== 'string') return out;
  if (rec.timestamp) ctx.lastTs = rec.timestamp;
  const ev = emitter(out, rec.timestamp || ctx.lastTs || undefined);
  // Legacy .json files are re-read whole, so every message id must stay remembered.
  const seen = ctx.seen.get(id) || remember(ctx.seen, id, { calls: new Set(), content: null, tokens: false }, 20000);

  if (rec.type === 'user') {
    if (seen.user) return out;
    seen.user = true;
    const text = partsText(rec.displayContent != null ? rec.displayContent : rec.content).trim();
    ctx.pendingFinal = false;
    ev('user.message', { content: text });
    ev('assistant.turn_start');
    return out;
  }
  if (rec.type === 'gemini') {
    modelChange(ctx, ev, rec.model);
    if (rec.tokens && typeof rec.tokens === 'object' && !seen.tokens) {
      seen.tokens = true;
      ev('session.usage_record', { usage: { outputTokens: num(rec.tokens.output) + num(rec.tokens.thoughts), inputTokens: num(rec.tokens.input) } });
    }
    const calls = Array.isArray(rec.toolCalls) ? rec.toolCalls : [];
    let fresh = false;
    let cancelled = false;
    for (const c of calls) {
      if (!c || !c.id || seen.calls.has(c.id)) continue;
      seen.calls.add(c.id);
      fresh = true;
      const at = c.timestamp || rec.timestamp;
      ev('tool.execution_start', { toolCallId: c.id, ...geminiTool(c.name, c.args, c.displayName) }, at);
      ev('tool.execution_complete', { toolCallId: c.id, success: c.status === 'success' }, at);
      if (c.status === 'cancelled') cancelled = true;
    }
    const text = partsText(rec.content).trim();
    if (text && text !== seen.content) {
      seen.content = text;
      ev('assistant.message', { content: text });
    }
    if (cancelled) {
      ctx.pendingFinal = false;
      ev('abort');
    } else if (calls.length) {
      // The model carries on after its tools.
      ctx.pendingFinal = false;
      if (fresh) ev('assistant.turn_start');
    } else if (text) {
      ctx.pendingFinal = true;
      ctx.preamble = GEMINI_PREAMBLE.test(text);
    }
    return out;
  }
  if (rec.type === 'error' && !seen.error) {
    seen.error = true;
    ctx.pendingFinal = false;
    ev('session.error', { message: partsText(rec.content) || 'Error' });
  }
  if (rec.type === 'info' && !seen.info) {
    seen.info = true;
    if (/cancel/i.test(partsText(rec.content))) {
      ctx.pendingFinal = false;
      ev('abort');
    }
  }
  return out;
}

const TRANSLATORS = { claude: claudeEvents, codex: codexEvents, gemini: geminiEvents };

module.exports = {
  META,
  TRANSLATORS,
  newContext,
  claudeEvents,
  codexEvents,
  geminiEvents,
  claudeTool,
  codexTool,
  geminiTool,
  isCodexSubagent,
  cleanCwd,
  partsText,
};
