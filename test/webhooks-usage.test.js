'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { shouldSend, buildPayload, sendWebhook } = require('../src/webhooks');
const { UsageCollector, aggregate, localDay } = require('../src/usage-stats');
const { sanitize, DEFAULTS } = require('../src/settings');

const session = { id: 's1', name: 'Refactor auth', status: 'approval', label: 'Approve shell', detail: 'rm -rf dist', cwd: 'C:\\src\\api' };

test('webhook payloads leave out details unless enabled', () => {
  const plain = buildPayload('attention', session, { now: 0 });
  assert.equal(plain.text, '🟠 Copilot needs approval — Refactor auth');
  assert.equal(plain.content, plain.text);
  assert.equal(plain.event, 'attention');
  assert.deepEqual(plain.session, { id: 's1', name: 'Refactor auth' });
  assert.ok(!('detail' in plain));
  assert.ok(!JSON.stringify(plain).includes('rm -rf'));
  assert.ok(!JSON.stringify(plain).includes('api'));

  const full = buildPayload('attention', session, { includeDetails: true, now: 0 });
  assert.equal(full.text, '🟠 Copilot needs approval — Refactor auth: rm -rf dist');
  assert.equal(full.session.folder, 'api');
  assert.equal(buildPayload('attention', { ...session, status: 'input' }).text.includes('waiting for your answer'), true);
});

test('webhook events follow their settings', () => {
  const s = { ...DEFAULTS, webhookUrl: 'https://hooks.example.com/x' };
  assert.equal(shouldSend('attention', s), true);
  assert.equal(shouldSend('done', s), false);
  assert.equal(shouldSend('done', { ...s, webhookOnDone: true }), true);
  assert.equal(shouldSend('stuck-tool', s), true);
  assert.equal(shouldSend('attention', { ...s, webhookUrl: '' }), false);
  assert.equal(shouldSend('nonsense', s), false);
});

test('webhook URL must be https', () => {
  assert.equal(sanitize({ webhookUrl: ' https://hooks.example.com/a?b=1 ' }).webhookUrl, 'https://hooks.example.com/a?b=1');
  assert.equal(sanitize({ webhookUrl: 'http://hooks.example.com' }).webhookUrl, '');
  assert.equal(sanitize({ webhookUrl: 'javascript:alert(1)' }).webhookUrl, '');
  assert.equal(sanitize({ webhookUrl: '' }, { ...DEFAULTS, webhookUrl: 'https://a.b/' }).webhookUrl, '');
  assert.equal(sanitize({ webhookUrl: 'not a url' }, { ...DEFAULTS, webhookUrl: 'https://a.b/' }).webhookUrl, 'https://a.b/');
});

test('sendWebhook posts JSON and reports HTTP failures', async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ type: req.headers['content-type'], body: JSON.parse(body) });
      res.writeHead(req.url === '/fail' ? 500 : 204).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await sendWebhook(`${base}/ok`, { text: 'hi' }), 204);
  assert.deepEqual(received[0], { type: 'application/json', body: { text: 'hi' } });
  await assert.rejects(sendWebhook(`${base}/fail`, { text: 'x' }), /HTTP 500/);
});

test('usage dashboard aggregates premium requests, prompts and models per day', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse('2026-10-28T12:00:00');
  const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
  const line = (type, data, daysAgo, extra = {}) => JSON.stringify({ type, data, timestamp: at(daysAgo), ...extra });
  const make = (id, cwd, lines) => {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'workspace.yaml'), `name: ${id}\ncwd: ${cwd}\n`);
    fs.writeFileSync(path.join(root, id, 'events.jsonl'), lines.join('\n') + '\n');
  };
  const usage = (cost, model, daysAgo, initiator = 'user') =>
    line('session.usage_record', { usage: { initiator, cost, model, modelDisplayName: model, outputTokens: 100 } }, daysAgo);
  make('a', 'C:\\src\\api', [line('user.message', {}, 0), usage(15, 'Opus', 0), usage(15, 'Opus', 0, 'agent'), line('user.message', {}, 0, { agentId: 'x' })]);
  make('b', 'C:\\src\\web', [line('user.message', {}, 2), usage(1, 'Haiku', 2), line('user.message', {}, 40), usage(30, 'Opus', 40)]);

  const collector = new UsageCollector(root);
  const report = aggregate(await collector.collect(), { days: 7, now });
  assert.deepEqual(report.totals, { premium: 16, outputTokens: 300, prompts: 2, sessions: 2 });
  assert.equal(report.daily.length, 7);
  assert.equal(report.daily[6].day, localDay(now));
  assert.equal(report.daily[6].premium, 15);
  assert.equal(report.daily[4].premium, 1);
  assert.deepEqual(report.folders.map((f) => [f.folder, f.premium]), [['src\\api', 15], ['src\\web', 1]]);
  assert.deepEqual(report.models.map((m) => m.model), ['Opus', 'Haiku']);
  // The 40-day-old usage only appears in a wider range.
  assert.equal(aggregate(await collector.collect(), { days: 90, now }).totals.premium, 46);
});
