'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { editTargets } = require('./session-state');
const { parseQuestion, validateAnswer, answerMessage } = require('./questions');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Original name kept so hooks installed before the rename are still found and removed.
const HOOK_FILE_NAME = 'copilot-notch.json';
// Copilot CLI kills the hook after this; it must exceed the longest approval timeout setting.
const HOOK_TIMEOUT_SEC = 135;

function truncate(text, max = 400) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Human-readable summary of a permissionRequest hook input ({ toolName, toolInput, ... }).
function summarizeRequest(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const sandboxBypass = input.requestSandboxBypass === true;
  switch (toolName) {
    case 'powershell':
    case 'bash':
    case 'shell':
      return { kind: 'shell', detail: truncate(input.command || input.description), sandboxBypass };
    case 'web_fetch':
      return { kind: 'url', detail: truncate(input.url), sandboxBypass };
    default: {
      const targets = editTargets(toolName, toolInput);
      if (targets.length) return { kind: 'write', detail: truncate(targets.map((t) => `${t.kind} ${t.path}`).join('\n')), sandboxBypass };
      let detail = '';
      try {
        detail = JSON.stringify(input);
      } catch {
        detail = '';
      }
      return { kind: toolName || 'tool', detail: truncate(detail), sandboxBypass };
    }
  }
}

// Hook output for a decision. "terminal" (or anything else) falls through to the CLI's own flow.
function hookResponse(decision) {
  if (decision === 'allow') return { behavior: 'allow' };
  if (decision === 'deny') return { behavior: 'deny', message: 'Denied by the user from Notch Picker.' };
  return {};
}

// Hook output for an ask_user question: the answer reaches the agent as the denial reason
// (the documented way for a preToolUse hook to hand text back). No answer falls through.
function questionResponse(decision, question, answer) {
  if (decision === 'answer' && question && answer) {
    return { permissionDecision: 'deny', permissionDecisionReason: answerMessage(question, answer) };
  }
  return {};
}

// Copilot CLI hook configuration that runs permission-hook.js with the app's own executable:
// `permissionRequest` for approvals and a `preToolUse` hook limited to ask_user for questions.
function hookConfig({ execPath, scriptPath, endpointFile, permissions = true, questions = false }) {
  const entry = (extraArgs = []) => ({
    type: 'command',
    exec: execPath,
    args: [scriptPath, ...extraArgs],
    env: { ELECTRON_RUN_AS_NODE: '1', COPILOT_NOTCH_ENDPOINT: endpointFile },
    timeoutSec: HOOK_TIMEOUT_SEC,
  });
  const hooks = {};
  if (permissions) hooks.permissionRequest = [entry()];
  if (questions) hooks.preToolUse = [{ ...entry(['question']), matcher: 'ask_user' }];
  return { version: 1, hooks };
}

function installHook(hooksDir, config) {
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, HOOK_FILE_NAME);
  const text = JSON.stringify(config, null, 2);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return file;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return file;
}

function uninstallHook(hooksDir) {
  const file = path.join(hooksDir, HOOK_FILE_NAME);
  if (fs.existsSync(file)) fs.rmSync(file);
}

// Local endpoint that the hooks call. Requests are only held for the user when
// `route(input, type)` says so; otherwise (and on timeout) the hook falls through to the normal
// Copilot CLI flow. Nothing is ever approved or answered without an explicit click.
// Request types: 'permission' (POST /permission) and 'question' (POST /question, ask_user).
class ApprovalServer extends EventEmitter {
  constructor({ endpointFile, route, getTimeoutMs, log = () => {} }) {
    super();
    this.endpointFile = endpointFile;
    this.route = route;
    this.getTimeoutMs = getTimeoutMs;
    this.log = log;
    this.token = crypto.randomBytes(32).toString('hex');
    this.pending = new Map(); // id -> { request, question, resolve, timer }
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address();
        fs.mkdirSync(path.dirname(this.endpointFile), { recursive: true });
        fs.writeFileSync(this.endpointFile, JSON.stringify({ port, token: this.token, pid: process.pid }), { mode: 0o600 });
        resolve(port);
      });
    });
  }

  stop() {
    for (const id of [...this.pending.keys()]) this.decide(id, 'terminal');
    if (this.server) this.server.close();
    this.server = null;
    try {
      const current = JSON.parse(fs.readFileSync(this.endpointFile, 'utf8'));
      if (current.token === this.token) fs.rmSync(this.endpointFile);
    } catch {
      // already gone
    }
  }

  list() {
    return [...this.pending.values()].map((p) => p.request);
  }

  forSession(sessionId) {
    return this.list().find((r) => r.sessionId === sessionId) || null;
  }

  // decision: 'allow' | 'deny' (permissions), 'answer' (questions, via answer()) | 'terminal'
  decide(id, decision, answer = null) {
    const p = this.pending.get(id);
    if (!p) return false;
    if (p.request.type === 'question' ? !['answer', 'terminal'].includes(decision) : decision === 'answer') return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve({ decision, answer });
    this.emit('change', this.list());
    return true;
  }

  // Answers a held question. The answer is checked against the form; invalid answers are refused.
  answer(id, raw) {
    const p = this.pending.get(id);
    if (!p || p.request.type !== 'question') return false;
    const answer = validateAnswer(p.question, raw);
    if (!answer) return false;
    return this.decide(id, 'answer', answer);
  }

  authorized(req) {
    const given = Buffer.from(String(req.headers['x-notch-token'] || ''));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  handle(req, res) {
    const send = (status, body) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || (req.url !== '/permission' && req.url !== '/question')) return send(404, {});
    if (!this.authorized(req)) return send(403, {});
    const type = req.url === '/question' ? 'question' : 'permission';

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        send(413, {});
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, {});
      }
      if (!input || typeof input !== 'object') return send(400, {});
      let question = null;
      if (type === 'question') {
        // Older CLIs may ignore the matcher; any other tool goes ahead untouched.
        if (input.toolName !== 'ask_user') return send(200, {});
        question = parseQuestion(input.toolArgs);
        if (!question) {
          this.log(`Question for session ${input.sessionId}: form not supported in the notch, left to the terminal`);
          return send(200, {});
        }
      }
      let ask = false;
      try {
        ask = await this.route(input, type);
      } catch (e) {
        this.log(`Approval routing failed: ${e.message}`);
      }
      if (!ask) {
        this.log(`${type === 'question' ? 'Question' : `Permission request (${input.toolName})`} for session ${input.sessionId}: left to the terminal`);
        return send(200, {});
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const timeoutMs = this.getTimeoutMs(type);
      const request =
        type === 'question'
          ? { id, type, sessionId: String(input.sessionId || ''), message: question.message, fields: question.fields, createdAt: now, expiresAt: now + timeoutMs }
          : {
              id,
              type,
              sessionId: String(input.sessionId || ''),
              toolName: String(input.toolName || ''),
              ...summarizeRequest(input.toolName, input.toolInput),
              createdAt: now,
              expiresAt: now + timeoutMs,
            };
      const { decision, answer } = await new Promise((resolve) => {
        const timer = setTimeout(() => this.decide(id, 'terminal'), timeoutMs);
        this.pending.set(id, { request, question, resolve, timer });
        // The CLI killed the hook (its own timeout, or the session ended): nothing to answer.
        res.on('close', () => {
          if (!res.writableEnded) this.decide(id, 'terminal');
        });
        this.emit('change', this.list());
      });
      this.log(`${type === 'question' ? 'Question' : `Permission request ${request.kind}`} ${id} for session ${request.sessionId}: ${decision} after ${Date.now() - now} ms`);
      send(200, type === 'question' ? questionResponse(decision, question, answer) : hookResponse(decision));
    });
  }
}

module.exports = {
  ApprovalServer,
  summarizeRequest,
  hookResponse,
  questionResponse,
  hookConfig,
  installHook,
  uninstallHook,
  HOOK_FILE_NAME,
  HOOK_TIMEOUT_SEC,
};
