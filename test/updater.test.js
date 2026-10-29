'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Updater, describeUpdate, isAllowedFeedUrl } = require('../src/updater');
const { sanitize } = require('../src/settings');

class FakeAutoUpdater extends EventEmitter {
  constructor(result) {
    super();
    this.result = result;
    this.feeds = [];
    this.installed = null;
  }
  setFeedURL(opts) {
    this.feeds.push(opts);
  }
  async checkForUpdates() {
    this.emit('checking-for-update');
    if (this.result === 'none') this.emit('update-not-available', {});
    else {
      this.emit('update-available', { version: '2.0.0' });
      if (this.autoDownload) {
        this.emit('download-progress', { percent: 50 });
        this.emit('update-downloaded', { version: '2.0.0' });
      }
    }
  }
  async downloadUpdate() {
    this.emit('update-downloaded', { version: '2.0.0' });
  }
  quitAndInstall(silent, runAfter) {
    this.installed = { silent, runAfter };
  }
}

function make(result, isPackaged = true) {
  const fake = new FakeAutoUpdater(result);
  const u = new Updater({ isPackaged, currentVersion: '1.10.0', loadAutoUpdater: () => fake });
  return { u, fake };
}

test('feed URLs: https anywhere, http only on this machine; stored with a trailing slash', () => {
  assert.ok(isAllowedFeedUrl('https://downloads.example.com/notch'));
  assert.ok(isAllowedFeedUrl('http://127.0.0.1:8080/'));
  assert.ok(isAllowedFeedUrl('http://localhost/feed/'));
  assert.ok(!isAllowedFeedUrl('http://downloads.example.com/'));
  assert.ok(!isAllowedFeedUrl('file:///C:/feed/'));
  assert.ok(!isAllowedFeedUrl('not a url'));
  assert.equal(sanitize({ updateFeedUrl: 'https://x.dev/notch' }).updateFeedUrl, 'https://x.dev/notch/');
  assert.equal(sanitize({ updateFeedUrl: 'http://evil.dev/' }).updateFeedUrl, '');
  assert.equal(sanitize({ updateFeedUrl: '' }, { ...sanitize({}), updateFeedUrl: 'https://x.dev/' }).updateFeedUrl, '');
});

test('updates stay off without a feed, and in development builds', () => {
  const { u, fake } = make('available');
  assert.equal(u.configure({ feedUrl: '', auto: true }).status, 'disabled');
  assert.equal(fake.feeds.length, 0, 'electron-updater is not even configured');
  const dev = make('available', false);
  assert.equal(dev.u.configure({ feedUrl: 'https://x.dev/', auto: true }).status, 'disabled');
  assert.match(describeUpdate(dev.u.state, '1.10.0'), /installed app/);
});

test('automatic mode downloads and offers a restart; manual mode waits for the user', async (t) => {
  const auto = make('available');
  t.after(() => auto.u.stopTimers());
  auto.u.configure({ feedUrl: 'https://x.dev/notch/', auto: true });
  assert.deepEqual(auto.fake.feeds, [{ provider: 'generic', url: 'https://x.dev/notch/' }]);
  assert.equal(auto.fake.autoInstallOnAppQuit, true);
  await auto.u.check();
  assert.equal(auto.u.state.status, 'ready');
  assert.equal(describeUpdate(auto.u.state, '1.10.0'), 'Version 2.0.0 is ready — restart to update');
  assert.ok(auto.u.installNow());
  assert.deepEqual(auto.fake.installed, { silent: true, runAfter: true });

  const manual = make('available');
  t.after(() => manual.u.stopTimers());
  manual.u.configure({ feedUrl: 'https://x.dev/notch/', auto: false });
  await manual.u.check();
  assert.equal(manual.u.state.status, 'available');
  assert.equal(manual.u.installNow(), false);
  await manual.u.download();
  assert.equal(manual.u.state.status, 'ready');

  const current = make('none');
  t.after(() => current.u.stopTimers());
  current.u.configure({ feedUrl: 'https://x.dev/notch/', auto: true });
  await current.u.check();
  assert.equal(describeUpdate(current.u.state, '1.10.0'), 'Up to date (version 1.10.0)');
});
