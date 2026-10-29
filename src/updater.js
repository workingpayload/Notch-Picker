'use strict';

const { EventEmitter } = require('events');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;

// https anywhere; plain http only on this machine (local test feeds).
function isAllowedFeedUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return !!u.hostname;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

// Auto-update from a "generic" feed (a folder or web server hosting latest.yml and the
// installer that `npm run dist` produces). Off until a feed URL is set; only for installed builds.
class Updater extends EventEmitter {
  constructor({ log = () => {}, isPackaged, currentVersion, loadAutoUpdater = () => require('electron-updater').autoUpdater }) {
    super();
    this.log = log;
    this.isPackaged = isPackaged;
    this.currentVersion = currentVersion;
    this.loadAutoUpdater = loadAutoUpdater;
    this.updater = null;
    this.feedUrl = '';
    this.auto = true;
    this.timer = null;
    this.firstTimer = null;
    this.state = { status: 'disabled', version: null, percent: 0, error: '', checkedAt: null };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  // Applies the settings. Returns the resulting state.
  configure({ feedUrl, auto }) {
    this.auto = auto !== false;
    const url = feedUrl && isAllowedFeedUrl(feedUrl) ? feedUrl : '';
    if (!url || !this.isPackaged) {
      this.stopTimers();
      this.feedUrl = '';
      if (this.state.status !== 'ready') this.setState({ status: 'disabled', error: this.isPackaged ? '' : 'Updates only work in the installed app' });
      return this.state;
    }
    const changed = url !== this.feedUrl;
    this.feedUrl = url;
    const u = this.ensureUpdater();
    if (!u) return this.state;
    u.autoDownload = this.auto;
    u.autoInstallOnAppQuit = this.auto;
    if (changed) {
      u.setFeedURL({ provider: 'generic', url });
      if (this.state.status === 'disabled') this.setState({ status: 'idle', error: '' });
      this.stopTimers();
      this.firstTimer = setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS);
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    }
    return this.state;
  }

  ensureUpdater() {
    if (this.updater) return this.updater;
    try {
      const u = this.loadAutoUpdater();
      u.logger = { info: (m) => this.log(`[update] ${m}`), warn: (m) => this.log(`[update] ${m}`), error: (m) => this.log(`[update] ${m}`), debug: () => {} };
      u.allowPrerelease = false;
      u.disableWebInstaller = true;
      u.on('checking-for-update', () => this.setState({ status: 'checking', error: '' }));
      u.on('update-available', (info) => this.setState({ status: this.auto ? 'downloading' : 'available', version: info.version, percent: 0 }));
      u.on('update-not-available', () => this.setState({ status: 'none', version: null, checkedAt: Date.now() }));
      u.on('download-progress', (p) => this.setState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
      u.on('update-downloaded', (info) => {
        this.log(`Update ${info.version} downloaded; installs on restart`);
        this.setState({ status: 'ready', version: info.version, percent: 100, checkedAt: Date.now() });
      });
      u.on('error', (e) => this.setState({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200), checkedAt: Date.now() }));
      this.updater = u;
    } catch (e) {
      this.log(`Auto-update unavailable: ${e.message}`);
      this.setState({ status: 'error', error: 'Updater could not be loaded' });
    }
    return this.updater;
  }

  async check() {
    if (!this.updater || !this.feedUrl) return this.state;
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    try {
      await this.updater.checkForUpdates();
    } catch (e) {
      // Reported through the 'error' event as well.
      if (this.state.status !== 'error') this.setState({ status: 'error', error: String(e.message || e).slice(0, 200) });
    }
    return this.state;
  }

  // Manual mode: download an update that was found.
  async download() {
    if (!this.updater || this.state.status !== 'available') return;
    this.setState({ status: 'downloading', percent: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (e) {
      this.setState({ status: 'error', error: String(e.message || e).slice(0, 200) });
    }
  }

  installNow() {
    if (!this.updater || this.state.status !== 'ready') return false;
    // Silent per-user install, then start the new version.
    this.updater.quitAndInstall(true, true);
    return true;
  }

  stopTimers() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }
}

// Short text for menus and the settings page.
function describeUpdate(state, currentVersion) {
  switch (state.status) {
    case 'disabled':
      return state.error || 'Automatic updates are off (no update feed set)';
    case 'idle':
      return `Version ${currentVersion}`;
    case 'checking':
      return 'Checking for updates…';
    case 'none':
      return `Up to date (version ${currentVersion})`;
    case 'available':
      return `Version ${state.version} is available`;
    case 'downloading':
      return `Downloading ${state.version || 'update'}… ${state.percent || 0}%`;
    case 'ready':
      return `Version ${state.version} is ready — restart to update`;
    case 'error':
      return `Update check failed: ${state.error}`;
    default:
      return '';
  }
}

module.exports = { Updater, describeUpdate, isAllowedFeedUrl };
