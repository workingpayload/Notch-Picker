'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { modelFamily, mascotImage, FAMILIES } = require('../src/mascots');

test('model names map to the Claude, Codex or Gemini mascot', () => {
  for (const m of ['claude-opus-5.5', 'claude-haiku-4.5', 'Claude Sonnet 4']) assert.equal(modelFamily(m), 'claude', m);
  for (const m of ['gpt-5.3-codex', 'gpt-6.1-sol', 'o3-mini', 'codex-mini']) assert.equal(modelFamily(m), 'codex', m);
  for (const m of ['gemini-3.8-flash', 'gemini-4-argon']) assert.equal(modelFamily(m), 'gemini', m);
  for (const m of ['grok-4.7', 'kimi-k3', '', null]) assert.equal(modelFamily(m), null, String(m));
});

test('every mascot image ships with the renderer', () => {
  const rendererDir = path.resolve(__dirname, '../src/renderer');
  for (const family of Object.keys(FAMILIES)) {
    const file = path.join(rendererDir, mascotImage(family));
    assert.ok(fs.existsSync(file), file);
    // PNG signature
    assert.deepEqual([...fs.readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
  assert.equal(mascotImage('unknown'), '');
});
