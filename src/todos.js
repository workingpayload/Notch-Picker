'use strict';

const fs = require('fs');

let sqlite;
// node:sqlite prints an ExperimentalWarning on first load; a tray app has no use for it on stderr.
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning && warning.message;
    if (/SQLite is an experimental feature/i.test(String(text))) return;
    return original.call(this, warning, ...rest);
  };
  try {
    sqlite = require('node:sqlite');
  } catch {
    sqlite = null;
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

// Reads todo progress from a Copilot CLI session.db. Returns null when there is no todo list.
// Opened read-only and closed immediately so the CLI's own writes are never blocked for long.
function readTodos(dbPath) {
  const lib = loadSqlite();
  if (!lib || !fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new lib.DatabaseSync(dbPath, { readOnly: true });
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get();
    if (!hasTable) return null;
    const counts = { pending: 0, in_progress: 0, done: 0, blocked: 0 };
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM todos GROUP BY status').all()) {
      if (row.status in counts) counts[row.status] = Number(row.n);
    }
    const total = counts.pending + counts.in_progress + counts.done + counts.blocked;
    if (total === 0) return null;
    const current = db
      .prepare("SELECT title FROM todos WHERE status = 'in_progress' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get();
    return {
      total,
      done: counts.done,
      inProgress: counts.in_progress,
      blocked: counts.blocked,
      current: current ? String(current.title) : null,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  }
}

// First markdown heading of plan.md, used as the plan's title.
function readPlanTitle(planPath) {
  try {
    const text = fs.readFileSync(planPath, 'utf8');
    const m = /^#\s+(.+)$/m.exec(text);
    return m ? m[1].trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

module.exports = { readTodos, readPlanTitle, loadSqlite };
