'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, isQuiet, QUNS } = require('../src/fullscreen');

test('full-screen monitor lines are parsed defensively', () => {
  const none = { foreground: 0, foregroundApp: '', foregroundRect: null };
  assert.deepEqual(parseLine('{"quns":2,"fullscreen":{"x":0,"y":0,"width":1920,"height":1200}}'), {
    quns: 2,
    fullscreen: { x: 0, y: 0, width: 1920, height: 1200 },
    ...none,
  });
  assert.deepEqual(parseLine('{"quns":5,"fullscreen":null}'), { quns: 5, fullscreen: null, ...none });
  assert.deepEqual(parseLine('{"quns":5,"fullscreen":{"x":"a"}}'), { quns: 5, fullscreen: null, ...none });
  assert.equal(parseLine('garbage'), null);
});

test('the foreground app and its frame are parsed only together', () => {
  const s = parseLine('{"quns":5,"fullscreen":null,"fg":7,"fgApp":"chrome","fgRect":{"x":-8,"y":0,"width":1936,"height":1150}}');
  assert.equal(s.foregroundApp, 'chrome');
  assert.deepEqual(s.foregroundRect, { x: -8, y: 0, width: 1936, height: 1150 });
  const noRect = parseLine('{"quns":5,"fullscreen":null,"fg":7,"fgApp":"chrome","fgRect":{"x":"a"}}');
  assert.deepEqual([noRect.foregroundApp, noRect.foregroundRect], ['', null]);
  const badApp = parseLine('{"quns":5,"fullscreen":null,"fg":7,"fgApp":"a\\u0000b","fgRect":{"x":0,"y":0,"width":9,"height":9}}');
  assert.deepEqual([badApp.foregroundApp, badApp.foregroundRect], ['', null]);
});

test('WSL terminal counts from the monitor are parsed', () => {
  assert.deepEqual(parseLine('{"wslClients":{"Ubuntu-22.04":2,"bad name":1,"Debian":0}}'), { wslClients: { 'Ubuntu-22.04': 2 } });
  assert.deepEqual(parseLine('{"wslClients":{}}'), { wslClients: {} });
  assert.deepEqual(parseLine('{"wslClients":3}'), { wslClients: {} });
});

test('presentation mode and quiet time count as quiet', () => {
  assert.equal(isQuiet({ quns: QUNS.PRESENTATION }), true);
  assert.equal(isQuiet({ quns: QUNS.QUIET_TIME }), true);
  assert.equal(isQuiet({ quns: QUNS.ACCEPTS }), false);
  assert.equal(isQuiet({ quns: QUNS.BUSY }), false);
});
