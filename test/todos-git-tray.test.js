'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTodos, readPlanTitle } = require('../src/todos');
const { parseStatus, GitInfo, gitCommand } = require('../src/git-info');
const { renderTrayIcon, STATUS_COLORS } = require('../src/tray-icon');
const { SessionTracker } = require('../src/watcher');

function makeDb(file, rows) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  const insert = db.prepare('INSERT INTO todos (id, title, status, updated_at) VALUES (?, ?, ?, ?)');
  for (const r of rows) insert.run(...r);
  db.close();
}

test('readTodos summarises a session.db todo list', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-todos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.db');
  makeDb(file, [
    ['a', 'Scaffold', 'done', '2026-01-01 10:00:00'],
    ['b', 'Write reducer', 'done', '2026-01-01 10:01:00'],
    ['c', 'Old work', 'in_progress', '2026-01-01 10:02:00'],
    ['d', 'Build watcher', 'in_progress', '2026-01-01 10:05:00'],
    ['e', 'Ship', 'pending', '2026-01-01 10:00:00'],
    ['f', 'Sign installer', 'blocked', '2026-01-01 10:00:00'],
  ]);
  assert.deepEqual(readTodos(file), { total: 6, done: 2, inProgress: 2, blocked: 1, current: 'Build watcher' });

  assert.equal(readTodos(path.join(dir, 'missing.db')), null);
  const empty = path.join(dir, 'empty.db');
  makeDb(empty, []);
  assert.equal(readTodos(empty), null);

  fs.writeFileSync(path.join(dir, 'plan.md'), 'intro\n# Copilot Notch plan\n## Todos\n');
  assert.equal(readPlanTitle(path.join(dir, 'plan.md')), 'Copilot Notch plan');
  assert.equal(readPlanTitle(path.join(dir, 'nope.md')), null);
});

test('tracker re-reads todos only when session.db changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-todos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.db');
  makeDb(file, [['a', 'One', 'pending', '2026-01-01 10:00:00']]);
  const tracker = new SessionTracker('s', dir);
  await tracker.refreshTodos();
  assert.equal(tracker.todos.done, 0);

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec("UPDATE todos SET status = 'done'");
  db.close();
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  await tracker.refreshTodos();
  assert.equal(tracker.todos.done, 1);
});

test('git porcelain v2 parsing: branch, ahead/behind, changes, detached', () => {
  assert.deepEqual(
    parseStatus(['# branch.oid 1e69c82', '# branch.head dev', '# branch.upstream origin/dev', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b src/x.js', '? new.txt', ''].join('\n')),
    { branch: 'dev', detached: false, ahead: 2, behind: 1, changed: 2 }
  );
  assert.deepEqual(parseStatus('# branch.oid 1e69c82653f8\n# branch.head (detached)\n'), {
    branch: '1e69c82',
    detached: true,
    ahead: 0,
    behind: 0,
    changed: 0,
  });
  assert.equal(parseStatus(''), null);
});

test('GitInfo caches per folder and refreshes after the TTL', async () => {
  let calls = 0;
  const git = new GitInfo({ ttlMs: 1000, run: async () => (calls++, '# branch.oid x\n# branch.head main\n') });
  const changed = new Promise((resolve) => git.once('change', resolve));
  assert.equal(git.get('C:\\repo', 0), null);
  await changed;
  assert.equal(git.get('C:\\repo', 10).branch, 'main');
  assert.equal(calls, 1);
  git.get('C:\\repo', Date.now() + 2000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(git.get(null), null);
});

test('git status for a folder on the WSL share runs Linux git inside the distro', () => {
  const [file, args] = gitCommand('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\app');
  assert.equal(file, 'wsl.exe');
  assert.deepEqual(args.slice(0, 7), ['-d', 'Ubuntu-22.04', '-e', 'git', '--no-optional-locks', '-C', '/home/me/app']);
  assert.equal(gitCommand('\\\\wsl$\\Debian\\srv')[1][1], 'Debian');
  assert.deepEqual(gitCommand('C:\\repo').slice(0, 1), ['git']);
  assert.equal(gitCommand('C:\\repo')[1][2], 'C:\\repo');
});

test('tray icon shows the status colour and an alert badge', () => {
  const px = (img, x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.buffer[i + 2], img.buffer[i + 1], img.buffer[i], img.buffer[i + 3]];
  };
  const tool = renderTrayIcon({ status: 'tool', size: 32 });
  assert.equal(tool.buffer.length, 32 * 32 * 4);
  assert.deepEqual(px(tool, 9, 16).slice(0, 3), STATUS_COLORS.tool);
  assert.equal(px(tool, 25, 7)[3], 0, 'no badge area painted without a badge');
  assert.equal(px(tool, 0, 0)[3], 0, 'corners are transparent');

  const alert = renderTrayIcon({ status: 'approval', badge: true, size: 32 });
  assert.deepEqual(px(alert, 25, 7).slice(0, 3), [255, 59, 48]);

  const light = renderTrayIcon({ status: 'idle', size: 32, taskbar: 'light' });
  assert.ok(px(light, 20, 16)[0] < 60, 'dark pill on light taskbars');
});
