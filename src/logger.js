'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;

// Echo to the console only when attached to a terminal (or explicitly asked). A GUI app's stdout
// may be a pipe that closes once its launcher exits, and writing to it then throws EPIPE.
const echo = process.env.NOTCH_LOG_STDOUT === '1' || !!(process.stdout && process.stdout.isTTY);
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') stream.on('error', () => {});
}

// Tiny append-only logger with one rotated backup, so diagnostics never grow unbounded.
function createLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line);
    } catch {
      // Logging must never crash the app.
    }
    if (echo) {
      try {
        process.stdout.write(line);
      } catch {
        // Console went away; the log file still has the line.
      }
    }
  };
}

module.exports = { createLogger };
