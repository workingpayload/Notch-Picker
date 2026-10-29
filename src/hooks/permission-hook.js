'use strict';

// Copilot CLI hook for Notch Picker.
//  - `permission-hook.js`           permissionRequest: prints { behavior, message } from the notch.
//  - `permission-hook.js question`  preToolUse for ask_user: prints { permissionDecision: 'deny',
//    permissionDecisionReason } carrying the user's answer.
// Forwards the hook input to the running notch app and prints its decision. On any problem
// (notch not running, network error, bad response) it prints nothing and exits 0, which makes
// Copilot CLI continue with its normal flow. It never denies on error.

const fs = require('fs');
const http = require('http');

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 130000;
const QUESTION = process.argv[2] === 'question';

function fallThrough() {
  process.exit(0);
}

// Only well-formed decisions are passed on to the CLI.
function decisionOutput(body) {
  if (!body || typeof body !== 'object') return null;
  if (QUESTION) {
    if (body.permissionDecision === 'deny' && typeof body.permissionDecisionReason === 'string') {
      return { permissionDecision: 'deny', permissionDecisionReason: body.permissionDecisionReason };
    }
    return null;
  }
  if (body.behavior === 'allow' || body.behavior === 'deny') {
    const out = { behavior: body.behavior };
    if (typeof body.message === 'string') out.message = body.message;
    return out;
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_INPUT_BYTES) chunks.push(c);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.alloc(0)));
  });
}

async function main() {
  const input = await readStdin();
  let endpoint;
  try {
    endpoint = JSON.parse(fs.readFileSync(process.env.COPILOT_NOTCH_ENDPOINT, 'utf8'));
  } catch {
    return fallThrough();
  }
  if (!Number.isInteger(endpoint.port) || typeof endpoint.token !== 'string') return fallThrough();

  const req = http.request(
    {
      host: '127.0.0.1',
      port: endpoint.port,
      path: QUESTION ? '/question' : '/permission',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': input.length, 'X-Notch-Token': endpoint.token },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return fallThrough();
        try {
          const out = decisionOutput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          // Exit only after the decision is flushed to the CLI.
          if (out) return process.stdout.write(JSON.stringify(out), fallThrough);
        } catch {
          // fall through
        }
        fallThrough();
      });
    }
  );
  req.on('timeout', () => req.destroy());
  req.on('error', fallThrough);
  req.end(input);
}

main().catch(fallThrough);
