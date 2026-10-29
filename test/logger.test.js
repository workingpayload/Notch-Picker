'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

test('logging keeps working after stdout is closed (no EPIPE crash)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notch.log');
  const script = `
    const log = require(${JSON.stringify(path.resolve(__dirname, '../src/logger.js'))}).createLogger(${JSON.stringify(file)});
    log('first');
    setTimeout(() => { for (let i = 0; i < 50; i++) log('after-close ' + i); }, 300);
  `;
  const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, NOTCH_LOG_STDOUT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  // Close our end of the pipe, like a launcher shell exiting.
  child.stdout.once('data', () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, stderr);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 51);
});
