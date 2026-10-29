'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLabels, updateLabel, applyLabel } = require('../src/labels');
const { sanitize } = require('../src/settings');

test('labels keep a clean single-line name and a known colour only', () => {
  const labels = sanitizeLabels({
    'sess-1': { name: '  API\n refactor\t ', color: 'blue' },
    'sess-2': { name: 'x'.repeat(80), color: 'chartreuse' },
    'sess-3': { name: '   ', color: 'nope' },
    'bad id!': { name: 'x' },
    'sess-4': 'junk',
  });
  assert.deepEqual(labels['sess-1'], { name: 'API refactor', color: 'blue' });
  assert.deepEqual(labels['sess-2'], { name: 'x'.repeat(60) });
  assert.deepEqual(Object.keys(labels), ['sess-1', 'sess-2']);
  assert.deepEqual(sanitize({ sessionLabels: { a: { color: 'red' } } }).sessionLabels, { a: { color: 'red' } });
});

test('rename, recolour and reset a session label', () => {
  let labels = updateLabel({}, 's1', { name: 'Docs' });
  labels = updateLabel(labels, 's1', { color: 'green' });
  assert.deepEqual(labels.s1, { name: 'Docs', color: 'green' });
  labels = updateLabel(labels, 's1', { name: '' });
  assert.deepEqual(labels.s1, { color: 'green' });
  labels = updateLabel(labels, 's1', { color: null });
  assert.equal(labels.s1, undefined, 'nothing left: the entry is removed');
});

test('the custom name and tag are shown, keeping Copilot’s name', () => {
  const session = { id: 's1', name: 'Implement ask_user tool call', status: 'idle' };
  assert.equal(applyLabel(session, {}), session);
  const shown = applyLabel(session, { s1: { name: 'Notch work', color: 'purple' } });
  assert.equal(shown.name, 'Notch work');
  assert.equal(shown.originalName, 'Implement ask_user tool call');
  assert.equal(shown.tag, 'purple');
  const colourOnly = applyLabel(session, { s1: { color: 'teal' } });
  assert.equal(colourOnly.name, session.name);
  assert.equal(colourOnly.originalName, undefined);
});
