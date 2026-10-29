'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, Notification, Tray, nativeImage, nativeTheme, screen, shell } = require('electron');
const { SessionWatcher, copilotHome, compareSessions } = require('./watcher');
const { Settings } = require('./settings');
const { AlertTracker, stuckKind, describeAlert } = require('./alerts');
const { createLogger } = require('./logger');
const { focusTerminal, findTerminalWindow } = require('./focus');
const { ApprovalServer, hookConfig, installHook, uninstallHook } = require('./approval');
const { UsageCollector, aggregate } = require('./usage-stats');
const { shouldSend, buildPayload, sendWebhook } = require('./webhooks');
const { NotchManager } = require('./notches');
const { FullscreenMonitor, isQuiet, QUNS } = require('./fullscreen');
const { GitInfo } = require('./git-info');
const { renderTrayIcon } = require('./tray-icon');
const { IdleTracker } = require('./visibility');
const { Updater, describeUpdate } = require('./updater');
const { LABEL_COLORS, updateLabel, applyLabel, cleanName } = require('./labels');
const { PetManager } = require('./pet-window');

// The original app ID (from when the app was Copilot Notch); see setAppUserModelId below.
const APP_ID = 'com.copilot.notch';

// Linux needs this for transparent (rounded) notch windows on most compositors.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

const HOVER_POLL_MS = 60;
const FOLLOW_CURSOR_MS = 400;
const ALERT_TICK_MS = 1000;

let notches = null;
let pet = null;
let latestDecorated = [];
let approvals = null;
let updater = null;
let dashboardWin = null;
let usage = null;
let fullscreen = null;
let settingsWin = null;
let petsWin = null;
let lastPetSessions = '';
let tray = null;
let trayKey = '';
let watcher = null;
let settings = null;
let log = () => {};
let latest = [];
let lastSentPayload = '';
const alerts = new AlertTracker();
const git = new GitInfo();
const idle = new IdleTracker();
const liveNotifications = new Set();

// Keep settings/logs in one place for both `npm start` and the installed app (whose product
// name differs). Tests and side-by-side runs can still override with --user-data-dir.
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  // The folder keeps the app's original name (Copilot Notch) so existing settings carry over.
  app.setPath('userData', path.join(app.getPath('appData'), 'copilot-notch'));
}

// Settings are read before 'ready' because the GPU choice must be made at startup.
settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
if (!settings.get().hardwareAcceleration) app.disableHardwareAcceleration();

// A background tray app must not stop on a modal error dialog; record the problem and carry on.
process.on('uncaughtException', (e) => log(`Uncaught exception: ${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => log(`Unhandled rejection: ${e && e.stack ? e.stack : e}`));

// A second launch (e.g. `--settings`) only signals the running instance and exits; it must not
// run any start-up (hooks, endpoint file, hotkey) on the way out.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function loginItemOptions() {
  // In development the executable is electron.exe and the app path must be passed as an argument.
  return app.isPackaged ? { path: process.execPath } : { path: process.execPath, args: [path.resolve(app.getAppPath())] };
}

function isLaunchAtLogin() {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function setLaunchAtLogin(enabled) {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: enabled });
}

// The login item is stored under the app ID; when the app's exe was renamed or moved (Copilot
// Notch became Notch Picker), it still points at the old exe. Keep it on, pointed at this one.
// Electron only reports entries that match the current exe, so the Run key is read directly.
function repointLaunchAtLogin() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  execFile('reg', ['query', key, '/v', APP_ID], { windowsHide: true }, (err, stdout) => {
    if (err) return; // no login item: nothing to move
    const m = /REG_SZ\s+(.+)$/m.exec(stdout);
    const exe = m && m[1].trim().replace(/^"([^"]+)".*$/, '$1');
    if (!exe || path.resolve(exe).toLowerCase() === path.resolve(process.execPath).toLowerCase()) return;
    try {
      setLaunchAtLogin(true);
      log(`Launch at login moved from ${exe} to ${process.execPath}`);
    } catch (e) {
      log(`Could not update launch at login: ${e.message}`);
    }
  });
}

// The installed app starts with the OS by default (once); users can turn it off from the tray.
// Linux has no login-item API in Electron.
function enableAutoStartOnFirstRun() {
  if (!app.isPackaged || process.platform === 'linux') return;
  const marker = path.join(app.getPath('userData'), '.autostart-initialized');
  if (fs.existsSync(marker)) return;
  setLaunchAtLogin(true);
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) {
    log(`Could not write ${marker}: ${e.message}`);
  }
  log('Enabled launch at login (first run of installed app)');
}

// Displays whose notch should hide because a full-screen app (or presentation mode) is active.
function fullscreenDisplayIds() {
  const ids = new Set();
  const state = fullscreen ? fullscreen.state : null;
  if (!state || !settings.get().hideInFullscreen) return ids;
  if (state.quns === QUNS.PRESENTATION) {
    for (const d of screen.getAllDisplays()) ids.add(d.id);
  } else if (state.fullscreen) {
    const rect = process.platform === 'win32' ? screen.screenToDipRect(null, state.fullscreen) : state.fullscreen;
    ids.add(screen.getDisplayMatching(rect).id);
  }
  return ids;
}

function applySettings(values) {
  notches.applySettings(values);
  notches.setHiddenDisplays(fullscreenDisplayIds());
  pet.sync();
  pet.setHiddenDisplays(fullscreenDisplayIds());
  if (fullscreen) fullscreen.setWindowTracking(values.pet && values.petRoam);
  registerHotkey(values.hotkey);
  syncApprovals(values);
  if (updater) updater.configure({ feedUrl: values.updateFeedUrl, auto: values.autoUpdate });
  send('sessions:ended', endedWithLabels());
  notches.broadcast('settings:changed', values);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', values);
  if (petsWin && !petsWin.isDestroyed()) petsWin.webContents.send('settings:changed', values);
  sendPetSessions(true);
  refresh(true);
}

let registeredHotkey = '';
let hotkeyOk = false;

// Global shortcut that toggles "pin expanded". Returns whether it is active.
function registerHotkey(accelerator) {
  if (accelerator === registeredHotkey && (hotkeyOk || !accelerator)) return hotkeyOk;
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  registeredHotkey = accelerator;
  hotkeyOk = false;
  if (!accelerator) return false;
  try {
    hotkeyOk = globalShortcut.register(accelerator, () => togglePin(undefined, { keyboard: true }));
  } catch (e) {
    log(`Invalid hotkey "${accelerator}": ${e.message}`);
  }
  if (!hotkeyOk) log(`Hotkey "${accelerator}" is unavailable (invalid or used by another app)`);
  return hotkeyOk;
}

function hotkeyLabel() {
  return registeredHotkey && hotkeyOk ? registeredHotkey : '';
}

let keyboardWin = null; // notch window focused for keyboard use while pinned via the hotkey
let restoreHwnd = 0; // window that had focus before, to give focus back on unpin
let lastExternalFg = 0;

function hwndOf(w) {
  try {
    const buf = w.getNativeWindowHandle();
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch {
    return 0;
  }
}

function ownWindowHandles() {
  const wins = notches.windows();
  if (settingsWin && !settingsWin.isDestroyed()) wins.push(settingsWin);
  if (pet) wins.push(...pet.windows());
  return new Set(wins.map(hwndOf));
}

// Remembers the last foreground window that is not one of ours.
function trackForeground(state) {
  if (state.foreground && !ownWindowHandles().has(state.foreground)) lastExternalFg = state.foreground;
}

// Pinning from the hotkey also focuses the notch so it can be used from the keyboard
// (Tab / arrows / Enter / Shift+F10, Esc to close); unpinning hands focus back.
function togglePin(force, { keyboard = false, win = null } = {}) {
  const pin = typeof force === 'boolean' ? force : !notches.pinned;
  notches.setPinned(pin);
  if (pin && keyboard) {
    const w = win || notches.primaryWindow();
    if (!w) return;
    restoreHwnd = lastExternalFg;
    keyboardWin = w;
    w.setFocusable(true);
    w.focus();
    w.webContents.send('notch:keyboard', true);
  } else if (!pin) {
    typing = null;
    releaseKeyboard();
  }
}

function releaseKeyboard() {
  if (!keyboardWin) return;
  const w = keyboardWin;
  keyboardWin = null;
  if (!w.isDestroyed()) {
    const hadFocus = w.isFocused();
    w.webContents.send('notch:keyboard', false);
    w.setFocusable(false);
    if (hadFocus && fullscreen) fullscreen.focusWindow(restoreHwnd);
  }
}

// Clicking a text box in a question (or renaming a card) focuses the notch (keyboard mode)
// until it's done; then focus goes back and the pin is restored to what it was.
let typing = null; // { wasPinned }

function startTyping(w) {
  if (!w || keyboardWin) return;
  typing = { wasPinned: notches.pinned };
  togglePin(true, { keyboard: true, win: w });
}

function endTyping() {
  if (!typing) return;
  const { wasPinned } = typing;
  typing = null;
  if (wasPinned) releaseKeyboard();
  else togglePin(false);
}

function questionPending() {
  return !!approvals && approvals.list().some((r) => r.type === 'question');
}

function endTypingIfDone() {
  if (typing && !questionPending() && !renaming) endTyping();
}

// ---- Auto-update ----

function updateMenuItems() {
  if (!updater || updater.state.status === 'disabled') return [];
  const s = updater.state;
  if (s.status === 'ready') return [{ label: `Restart to update to ${s.version}`, click: () => updater.installNow() }];
  if (s.status === 'available') return [{ label: `Download version ${s.version}`, click: () => updater.download() }];
  if (s.status === 'checking' || s.status === 'downloading') return [{ label: describeUpdate(s, app.getVersion()), enabled: false }];
  return [{ label: 'Check for updates', click: () => updater.check() }];
}

let announcedUpdate = null;

function onUpdateState(state) {
  const payload = { state, text: describeUpdate(state, app.getVersion()) };
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:state', payload);
  if (state.status !== 'ready' || announcedUpdate === state.version) return;
  announcedUpdate = state.version;
  if (!settings.get().notifications || !Notification.isSupported()) return;
  const n = new Notification({ title: 'Notch Picker update ready', body: `Version ${state.version} installs when you restart the app. Click to restart now.`, silent: true });
  liveNotifications.add(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    updater.installNow();
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function buildMenu() {
  const values = settings.get();
  return Menu.buildFromTemplate([
    { label: `Notch Picker — ${latest.length} live session${latest.length === 1 ? '' : 's'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Show notch',
      type: 'checkbox',
      checked: notches.isShown(),
      click: (item) => notches.setUserHidden(!item.checked),
    },
    {
      label: 'Pin expanded',
      type: 'checkbox',
      checked: notches.pinned,
      accelerator: hotkeyLabel() || undefined,
      registerAccelerator: false,
      click: (item) => togglePin(item.checked),
    },
    {
      label: 'Compact when idle',
      type: 'checkbox',
      checked: values.compactWhenIdle,
      click: (item) => settings.set({ compactWhenIdle: item.checked }),
    },
    {
      label: 'Auto-hide when idle',
      type: 'checkbox',
      checked: values.autoHideWhenIdle,
      click: (item) => settings.set({ autoHideWhenIdle: item.checked }),
    },
    {
      label: 'Show on',
      submenu: [
        ['primary', 'Primary display'],
        ['cursor', 'Display with the cursor'],
        ['all', 'All displays'],
      ].map(([value, label]) => ({
        label,
        type: 'radio',
        checked: values.display === value,
        click: () => settings.set({ display: value }),
      })),
    },
    {
      label: 'Hide during full-screen apps',
      type: 'checkbox',
      checked: values.hideInFullscreen,
      click: (item) => settings.set({ hideInFullscreen: item.checked }),
    },
    {
      label: 'Hide from screen sharing',
      type: 'checkbox',
      checked: values.hideFromScreenCapture,
      click: (item) => settings.set({ hideFromScreenCapture: item.checked }),
    },
    {
      label: 'Desktop pets',
      type: 'checkbox',
      checked: values.pet,
      click: (item) => settings.set({ pet: item.checked }),
    },
    { label: 'Pet settings…', click: openPetSettings },
    {
      label: 'Notifications',
      type: 'checkbox',
      checked: values.notifications,
      click: (item) => settings.set({ notifications: item.checked }),
    },
    {
      label: 'Sound',
      type: 'checkbox',
      checked: values.sound,
      click: (item) => settings.set({ sound: item.checked }),
    },
    { label: 'Settings…', click: openSettings },
    { label: 'Usage dashboard…', click: openDashboard },
    ...updateMenuItems(),
    {
      label: 'Size',
      submenu: [
        ['tiny', 'Tiny'],
        ['small', 'Small'],
        ['normal', 'Normal'],
      ].map(([value, label]) => ({
        label,
        type: 'radio',
        checked: values.size === value,
        click: () => settings.set({ size: value }),
      })),
    },
    {
      label: 'Position',
      submenu: [
        ...[
          ['left', 'Top left'],
          ['center', 'Top center'],
          ['right', 'Top right'],
        ].map(([value, label]) => ({
          label,
          type: 'radio',
          checked: values.position === value,
          click: () => settings.set({ position: value, offsetX: 0 }),
        })),
        { type: 'separator' },
        { label: 'Reset dragged offset', enabled: values.offsetX !== 0, click: () => settings.set({ offsetX: 0 }) },
      ],
    },
    {
      label: 'Theme',
      submenu: [
        ['dark', 'Dark'],
        ['light', 'Light'],
        ['system', 'Match Windows'],
      ].map(([value, label]) => ({
        label,
        type: 'radio',
        checked: values.theme === value,
        click: () => settings.set({ theme: value }),
      })),
    },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      visible: process.platform !== 'linux',
      checked: process.platform !== 'linux' && isLaunchAtLogin(),
      click: (item) => setLaunchAtLogin(item.checked),
    },
    { label: 'Open session-state folder', click: () => shell.openPath(path.join(copilotHome(), 'session-state')) },
    { label: 'Open log', click: () => shell.openPath(logFile()) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function logFile() {
  return path.join(app.getPath('userData'), 'notch.log');
}

function trayImage(status, badge) {
  const taskbar = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === false ? 'light' : 'dark';
  const img1x = renderTrayIcon({ status, badge, size: 16, taskbar });
  const img2x = renderTrayIcon({ status, badge, size: 32, taskbar });
  const image = nativeImage.createFromBitmap(img1x.buffer, { width: 16, height: 16, scaleFactor: 1 });
  image.addRepresentation({
    scaleFactor: 2,
    dataURL: nativeImage.createFromBitmap(img2x.buffer, { width: 32, height: 32, scaleFactor: 2 }).toDataURL(),
  });
  return image;
}

// Tray icon: dot colour = most urgent unmuted session; red badge = something needs you.
function updateTray(sessions) {
  if (!tray) return;
  const live = sessions.filter((s) => !s.muted);
  const top = live[0];
  let status = null;
  if (top) {
    if (top.stuck === 'tool') status = 'stuck';
    else if (top.status === 'idle' && top.label === 'Done') status = 'done';
    else status = top.status;
  }
  const waiting = live.filter((s) => s.status === 'approval' || s.status === 'input').length;
  const key = `${status}|${waiting > 0}|${nativeTheme.shouldUseDarkColorsForSystemIntegratedUI}`;
  if (key !== trayKey) {
    trayKey = key;
    tray.setImage(trayImage(status, waiting > 0));
  }
  const tip = top
    ? `Copilot: ${top.label} — ${top.name}${waiting ? ` (${waiting} waiting for you)` : ''}`
    : sessions.length
      ? `Notch Picker — ${sessions.length} muted session${sessions.length === 1 ? '' : 's'}`
      : 'Notch Picker — no live sessions';
  tray.setToolTip(tip.length > 127 ? `${tip.slice(0, 126)}…` : tip);
}

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
};

function forwardConsole(w, name) {
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(`[${name}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
}

// Windows applies the launching process's start-up show state to the first normally-shown
// window, which can leave it minimized (e.g. when started from a hidden shell or at login).
function showWindow(w) {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function openDashboard() {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    showWindow(dashboardWin);
    return;
  }
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  dashboardWin = new BrowserWindow({
    width: 760,
    height: Math.min(820, workArea.height - 40),
    minWidth: 560,
    minHeight: 480,
    title: 'Notch Picker — Usage',
    backgroundColor: '#1c1c1e',
    autoHideMenuBar: true,
    show: false,
    webPreferences,
  });
  dashboardWin.setMenu(null);
  dashboardWin.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  forwardConsole(dashboardWin, 'dashboard');
  dashboardWin.once('ready-to-show', () => showWindow(dashboardWin));
  dashboardWin.on('closed', () => {
    dashboardWin = null;
  });
}

async function usageReport(days) {
  usage = usage || new UsageCollector(path.join(copilotHome(), 'session-state'));
  const report = aggregate(await usage.collect(), { days: [7, 30, 90].includes(days) ? days : 7 });
  const quotas = latest.map((s) => s.quota).filter(Boolean);
  report.quota = quotas.sort((a, b) => b.at - a.at)[0] || null;
  return report;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    showWindow(settingsWin);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 400,
    height: Math.min(860, screen.getPrimaryDisplay().workAreaSize.height - 40),
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'Notch Picker Settings',
    backgroundColor: '#1c1c1e',
    autoHideMenuBar: true,
    show: false,
    webPreferences,
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  forwardConsole(settingsWin, 'settings');
  settingsWin.once('ready-to-show', () => showWindow(settingsWin));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// Pet settings: all the pet options, a preview, and each session's pet.
function openPetSettings() {
  if (petsWin && !petsWin.isDestroyed()) {
    showWindow(petsWin);
    return;
  }
  petsWin = new BrowserWindow({
    width: 460,
    height: Math.min(900, screen.getPrimaryDisplay().workAreaSize.height - 40),
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'Notch Picker Pet settings',
    backgroundColor: '#1c1c1e',
    autoHideMenuBar: true,
    show: false,
    webPreferences,
  });
  petsWin.setMenu(null);
  petsWin.loadFile(path.join(__dirname, 'renderer', 'pets.html'));
  forwardConsole(petsWin, 'pets');
  petsWin.once('ready-to-show', () => showWindow(petsWin));
  petsWin.on('closed', () => {
    petsWin = null;
  });
}

// Live sessions and their pets, for the pet settings window.
function petSessions() {
  const chosen = settings.get().petSpecies;
  return latestDecorated.map((s) => ({
    id: s.id,
    name: s.name,
    tag: s.tag || null,
    muted: !!s.muted,
    chosen: chosen[s.id] || null,
    auto: pet.autoSpeciesOf(s.id),
    hasPet: pet.hasPet(s.id),
  }));
}

function sendPetSessions(force = false) {
  if (!petsWin || petsWin.isDestroyed() || !pet) return;
  const list = petSessions();
  const json = JSON.stringify(list);
  if (!force && json === lastPetSessions) return;
  lastPetSessions = json;
  petsWin.webContents.send('pets:sessions', list);
}

function send(channel, payload) {
  if (notches) notches.broadcast(channel, payload);
}

async function focusSession(id) {
  const session = latest.find((s) => s.id === id);
  if (!session) return { ok: false, detail: 'session not found' };
  const result = await focusTerminal(session.pid);
  if (!result.ok) log(`Could not focus terminal for session ${id} (pid ${session.pid}): ${result.detail}`);
  return result;
}

function vscodeUrl(dir) {
  return `vscode://file/${encodeURI(dir.replace(/\\/g, '/'))}`;
}

function buildSessionMenu(session, window) {
  const hasCwd = !!session.cwd;
  const label = settings.get().sessionLabels[session.id] || {};
  const colorName = (c) => c[0].toUpperCase() + c.slice(1);
  return Menu.buildFromTemplate([
    { label: session.originalName ? `${session.name} (${session.originalName})` : session.name, enabled: false },
    { type: 'separator' },
    { label: 'Open terminal', click: () => focusSession(session.id) },
    { label: 'Open folder', enabled: hasCwd, click: () => shell.openPath(session.cwd) },
    { label: 'Open folder in VS Code', enabled: hasCwd, click: () => shell.openExternal(vscodeUrl(session.cwd)) },
    { type: 'separator' },
    { label: 'Rename…', click: () => startRename(session.id, window) },
    ...(label.name ? [{ label: 'Reset name', click: () => setLabel(session.id, { name: '' }) }] : []),
    {
      label: 'Colour tag',
      submenu: [
        { label: 'None', type: 'radio', checked: !label.color, click: () => setLabel(session.id, { color: null }) },
        { type: 'separator' },
        ...LABEL_COLORS.map((c) => ({
          label: colorName(c),
          type: 'radio',
          checked: label.color === c,
          click: () => setLabel(session.id, { color: c }),
        })),
      ],
    },
    ...(settings.get().pet && settings.get().petMode === 'perSession' ? [{ label: 'Pet', submenu: petSpeciesItems(session.id) }] : []),
    { type: 'separator' },
    isMuted(session.id)
      ? { label: 'Unmute session', click: () => setMuted(session.id, false) }
      : { label: 'Mute session', toolTip: 'No alerts, sounds or pill takeover from this session', click: () => setMuted(session.id, true) },
    { type: 'separator' },
    { label: 'Copy resume command', click: () => clipboard.writeText(`copilot --resume ${session.id}`) },
    { label: 'Copy session ID', click: () => clipboard.writeText(session.id) },
    { label: 'Open session-state folder', click: () => shell.openPath(path.join(copilotHome(), 'session-state', session.id)) },
  ]);
}

// Windows only closes a popup menu on an outside click when its owner window is in the
// foreground, and notch windows normally can't take focus. Let the notch take focus while its
// menu is open; afterwards make it non-focusable again and, if it still has focus (Esc or a
// menu item that doesn't move focus), give focus back to the app the user was in.
function popupMenu(menu, window) {
  if (!window || window.isDestroyed()) return;
  const borrowFocus = process.platform === 'win32' && (notches.notchFor(window.webContents) || pet.isPetWindow(window.webContents)) && window !== keyboardWin;
  if (!borrowFocus) return menu.popup({ window });
  const previous = lastExternalFg;
  window.setFocusable(true);
  window.focus();
  menu.popup({
    window,
    callback: () => {
      if (window.isDestroyed() || window === keyboardWin) return;
      const hadFocus = window.isFocused();
      window.setFocusable(false);
      if (hadFocus && fullscreen && previous) fullscreen.focusWindow(previous);
    },
  });
}

function showSessionMenu(id, window) {
  const session = latest.find((s) => s.id === id);
  if (session && window) popupMenu(buildSessionMenu(applyLabel(session, settings.get().sessionLabels), window), window);
}

// ---- Desktop pets ----

const SPECIES_NAMES = { cat: 'Cat', dog: 'Dog', pig: 'Pig', sheep: 'Sheep', goat: 'Goat' };

// Clicking a pet while its session (single pet: any session) needs you opens that session's
// terminal; otherwise the click is a pat. Returns whether it opened a terminal.
function activatePet(sessionId) {
  const needsYou = (s) => !s.muted && (s.status === 'approval' || s.status === 'input');
  const target = sessionId ? latestDecorated.find((s) => s.id === sessionId && needsYou(s)) : latestDecorated.find(needsYou);
  if (!target) return false;
  focusSession(target.id);
  return true;
}

// Species choice for one session's pet: automatic (next in turn) or a fixed species.
function setPetSpecies(sessionId, species) {
  const map = { ...settings.get().petSpecies };
  delete map[sessionId];
  if (species) map[sessionId] = species;
  settings.set({ petSpecies: map });
}

function petSpeciesItems(sessionId) {
  const chosen = settings.get().petSpecies[sessionId] || null;
  return [
    { label: 'Automatic', type: 'radio', checked: !chosen, click: () => setPetSpecies(sessionId, null) },
    { type: 'separator' },
    ...Object.entries(SPECIES_NAMES).map(([value, label]) => ({
      label,
      type: 'radio',
      checked: chosen === value,
      click: () => setPetSpecies(sessionId, value),
    })),
  ];
}

// Right-click (or long-press) on a pet. `info`: { sessionId, species } of that pet.
function buildPetMenu(info) {
  const values = settings.get();
  const radio = (key, options) =>
    options.map(([value, label]) => ({ label, type: 'radio', checked: values[key] === value, click: () => settings.set({ [key]: value }) }));
  const session = info.sessionId && withLabels(latest).find((s) => s.id === info.sessionId);
  const own = info.sessionId
    ? [
        { label: session ? `${SPECIES_NAMES[info.species]} of ${session.name}` : SPECIES_NAMES[info.species], enabled: false },
        { type: 'separator' },
        { label: 'Open terminal', enabled: !!session, click: () => focusSession(info.sessionId) },
        { label: 'Pet', submenu: petSpeciesItems(info.sessionId) },
      ]
    : [
        { label: 'Desktop pet', enabled: false },
        { type: 'separator' },
        { label: 'Pet', submenu: radio('petSingleSpecies', Object.entries(SPECIES_NAMES)) },
      ];
  return Menu.buildFromTemplate([
    ...own,
    {
      label: 'Pets',
      submenu: radio('petMode', [
        ['single', 'One pet for everything'],
        ['perSession', 'One pet per session'],
      ]),
    },
    {
      label: 'Lives on',
      submenu: radio('petPlacement', [
        ['taskbar', 'The taskbar'],
        ['notch', 'The notch'],
        ['both', 'Both (jumps up when a session needs you)'],
      ]),
    },
    {
      label: 'Cat colour',
      submenu: radio('petColor', [
        ['orange', 'Orange tabby'],
        ['grey', 'Grey'],
        ['black', 'Black'],
        ['white', 'White'],
      ]),
    },
    { label: 'Roam the screen', type: 'checkbox', checked: values.petRoam, click: (item) => settings.set({ petRoam: item.checked }) },
    { label: 'Play together', type: 'checkbox', checked: values.petPlay, click: (item) => settings.set({ petPlay: item.checked }) },
    { label: 'Chase the mouse', type: 'checkbox', checked: values.petChaseCursor, click: (item) => settings.set({ petChaseCursor: item.checked }) },
    { type: 'separator' },
    { label: 'Pet settings…', click: openPetSettings },
    { label: 'Hide pets', click: () => settings.set({ pet: false }) },
  ]);
}

// ---- Session names and colour tags ----

function withLabels(list) {
  const labels = settings.get().sessionLabels;
  return list.map((s) => applyLabel(s, labels));
}

function setLabel(id, patch) {
  settings.set({ sessionLabels: updateLabel(settings.get().sessionLabels, id, patch) });
}

function endedWithLabels() {
  return watcher ? withLabels(watcher.endedSessions) : [];
}

// Rename from the menu: the card turns into a text box, and the notch takes keyboard focus
// (as when answering a question) until the name is saved or cancelled.
let renaming = false;

function startRename(id, window) {
  const w = window && !window.isDestroyed() ? window : notches.primaryWindow();
  if (!w) return;
  renaming = true;
  // Let the menu's own focus hand-back finish first.
  setTimeout(() => {
    if (w.isDestroyed()) return;
    w.webContents.send('notch:rename', id);
    startTyping(w);
  }, 120);
}

function showEndedMenu(id, window) {
  const e = endedWithLabels().find((s) => s.id === id);
  if (!e || !window) return;
  const hasCwd = !!e.cwd;
  const menu = Menu.buildFromTemplate([
    { label: e.name, enabled: false },
    { type: 'separator' },
    { label: 'Copy resume command', click: () => clipboard.writeText(`copilot --resume ${e.id}`) },
    { label: 'Open folder', enabled: hasCwd, click: () => shell.openPath(e.cwd) },
    { label: 'Open folder in VS Code', enabled: hasCwd, click: () => shell.openExternal(vscodeUrl(e.cwd)) },
    { label: 'Open session-state folder', click: () => shell.openPath(path.join(copilotHome(), 'session-state', e.id)) },
    { type: 'separator' },
    { label: 'Remove from list', click: () => watcher.dismissEnded(e.id) },
    { label: 'Clear all ended sessions', click: () => watcher.clearEnded() },
  ]);
  popupMenu(menu, window);
}

// Fire-and-forget webhook for an alert; failures are logged (without the URL, which is a secret).
function webhook(kind, session) {
  const values = settings.get();
  if (!shouldSend(kind, values)) return;
  const payload = buildPayload(kind, session, { includeDetails: values.webhookIncludeDetails });
  sendWebhook(values.webhookUrl, payload).catch((e) => log(`Webhook (${kind}) failed: ${e.message}`));
}

function notify(alert, { webhook: sendHook = true } = {}) {
  if (sendHook) webhook(alert.kind, alert.session);
  const values = settings.get();
  const quiet = values.muteInFocusAssist && fullscreen && isQuiet(fullscreen.state);
  if (values.sound && !quiet) {
    // One chime, even when a notch is shown on several displays.
    const w = notches.primaryWindow();
    if (w) w.webContents.send('notch:chime', alert.kind);
  }
  if (!values.notifications || !Notification.isSupported()) return;
  const { title, body } = describeAlert(alert);
  const n = new Notification({ title, body, silent: true, timeoutType: alert.kind === 'done' ? 'default' : 'never' });
  // Keep a reference: garbage-collected notifications lose their click handler.
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on('click', () => {
    release();
    if (alert.session && alert.session.id) focusSession(alert.session.id);
  });
  n.on('close', release);
  n.on('failed', (_e, err) => {
    release();
    log(`Notification failed: ${err}`);
  });
  n.show();
}

// Adds time-based "stuck" flags and mute state, pushes changes to the notch and fires due alerts.
// Sessions with a request waiting in the notch (approve/answer from the notch) show as needing
// approval or input: the CLI hasn't logged it yet because the hooks run before its own prompt.
function withPendingApprovals(sessions) {
  if (!approvals) return sessions;
  return sessions
    .map((s) => {
      const p = approvals.forSession(s.id);
      if (!p) return s;
      if (p.type === 'question') {
        return { ...s, status: 'input', label: 'Question for you', detail: p.message, since: p.createdAt, pendingQuestion: p };
      }
      return { ...s, status: 'approval', label: `Approve ${p.kind}`, detail: p.detail, since: p.createdAt, pendingApproval: p };
    })
    .sort(compareSessions);
}

function refresh(force = false) {
  const now = Date.now();
  const values = settings.get();
  const muted = new Set(values.mutedSessions);
  const effective = withPendingApprovals(withLabels(latest));
  const decorated = effective.map((s) => ({
    ...s,
    stuck: stuckKind(s, now, values),
    muted: muted.has(s.id),
    git: git.get(s.cwd, now),
  }));
  // Muted sessions never take the pill; Array.prototype.sort is stable so priority order is kept.
  decorated.sort((a, b) => Number(a.muted) - Number(b.muted));
  latestDecorated = decorated;
  pet.setSessions(decorated);
  sendPetSessions();
  const payload = JSON.stringify(decorated);
  if (force || payload !== lastSentPayload) {
    lastSentPayload = payload;
    send('sessions:update', decorated);
    updateTray(decorated);
  }
  for (const alert of alerts.update(effective.filter((s) => !muted.has(s.id)), now, values)) notify(alert);
  const idleNow = idle.update(decorated, now);
  notches.setIdleHidden(values.autoHideWhenIdle && idleNow);
}

// ---- Approve from the notch (opt-in) ----

function hookScriptPath() {
  return path.join(__dirname, 'hooks', 'permission-hook.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function endpointFile() {
  return path.join(app.getPath('userData'), 'approval-endpoint.json');
}

// The user is "at" a session when its terminal window is in the foreground. If that can't be
// determined, requests are left to the terminal (never intercepted on a guess).
async function userAtTerminal(session) {
  const fg = fullscreen && fullscreen.state.foreground;
  if (!fg) return true;
  if (ownWindowHandles().has(fg)) return false;
  const terminal = await findTerminalWindow(session.pid);
  return !terminal || fg === terminal;
}

async function routePermission(input, type = 'permission') {
  const values = settings.get();
  if (!(type === 'question' ? values.answerFromNotch : values.approveFromNotch)) return false;
  const session = latest.find((s) => s.id === input.sessionId);
  if (!session || isMuted(session.id)) return false;
  if (values.approvalOnlyWhenAway && (await userAtTerminal(session))) return false;
  return true;
}

// "Only when away": switching to a session's terminal hands its held request back to the
// terminal prompt, so the user can answer it there right away.
async function returnRequestsToTerminal(foreground) {
  if (!approvals || !foreground || !settings.get().approvalOnlyWhenAway) return;
  for (const request of approvals.list()) {
    const session = latest.find((s) => s.id === request.sessionId);
    if (!session) continue;
    const terminal = await findTerminalWindow(session.pid);
    if (terminal && terminal === foreground && approvals.decide(request.id, 'terminal')) {
      log(`Request ${request.id} returned to the terminal: its window was activated`);
    }
  }
}

// Starts/stops the local endpoint and installs/removes the Copilot CLI hook to match the
// settings. The hook only exists while one of the features is on.
async function syncApprovals(values) {
  const hooksDir = path.join(copilotHome(), 'hooks');
  if (values.approveFromNotch || values.answerFromNotch) {
    if (!approvals) {
      approvals = new ApprovalServer({
        endpointFile: endpointFile(),
        route: routePermission,
        getTimeoutMs: (type) => (type === 'question' ? settings.get().questionTimeoutSec : settings.get().approvalTimeoutSec) * 1000,
        log,
      });
      approvals.on('change', () => {
        endTypingIfDone();
        refresh(true);
      });
      try {
        await approvals.start();
      } catch (e) {
        log(`Approval endpoint failed to start: ${e.message}`);
        approvals = null;
        return;
      }
    }
    try {
      installHook(
        hooksDir,
        hookConfig({
          execPath: process.execPath,
          scriptPath: hookScriptPath(),
          endpointFile: endpointFile(),
          permissions: values.approveFromNotch,
          questions: values.answerFromNotch,
        })
      );
    } catch (e) {
      log(`Could not install the Copilot CLI hook: ${e.message}`);
    }
    // Requests of a type that was just switched off go back to the terminal.
    for (const r of approvals.list()) {
      if (!(r.type === 'question' ? values.answerFromNotch : values.approveFromNotch)) approvals.decide(r.id, 'terminal');
    }
  } else {
    try {
      uninstallHook(hooksDir);
    } catch (e) {
      log(`Could not remove the Copilot CLI hook: ${e.message}`);
    }
    if (approvals) {
      approvals.stop();
      approvals = null;
      refresh(true);
    }
  }
}

function isMuted(id) {
  return settings.get().mutedSessions.includes(id);
}

function setMuted(id, mute) {
  const ids = settings.get().mutedSessions.filter((x) => x !== id);
  if (mute) ids.push(id);
  settings.set({ mutedSessions: ids });
}

function registerIpc() {
  ipcMain.handle('sessions:get', () => JSON.parse(lastSentPayload || '[]'));
  ipcMain.handle('session:focus', (_e, id) => focusSession(String(id)));
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => settings.set(patch));
  ipcMain.handle('settings:test-notification', () => {
    const sample = latest[0] || { id: '', name: 'Sample session', status: 'approval', label: 'Approve shell', detail: 'npm run deploy' };
    notify({ kind: 'attention', session: { ...sample, status: 'approval', detail: sample.detail || 'Test notification' } }, { webhook: false });
    return true;
  });
  ipcMain.handle('settings:test-webhook', async () => {
    const values = settings.get();
    if (!values.webhookUrl) return { ok: false, detail: 'Set an https webhook URL first' };
    try {
      const sample = latest[0] || { id: 'sample', name: 'Sample session', status: 'idle', label: 'Idle' };
      const status = await sendWebhook(values.webhookUrl, buildPayload('test', sample, { includeDetails: values.webhookIncludeDetails }));
      return { ok: true, detail: `Delivered (HTTP ${status})` };
    } catch (e) {
      return { ok: false, detail: `Failed: ${e.message}` };
    }
  });
  ipcMain.handle('settings:hotkey-status', () => ({ accelerator: registeredHotkey, registered: hotkeyOk }));
  ipcMain.handle('usage:get', (_e, days) => usageReport(Number(days)));
  ipcMain.handle('update:get', () => ({ state: updater.state, text: describeUpdate(updater.state, app.getVersion()), version: app.getVersion() }));
  ipcMain.handle('update:check', async () => {
    const state = await updater.check();
    return { state, text: describeUpdate(state, app.getVersion()) };
  });
  ipcMain.on('update:install', () => updater.installNow());
  ipcMain.handle('notch:get-pinned', () => notches.pinned);
  ipcMain.on('notch:toggle-pin', () => togglePin());
  ipcMain.on('approval:decide', (_e, id, decision) => {
    if (!approvals || !['allow', 'deny', 'terminal'].includes(decision)) return;
    const request = approvals.list().find((r) => r.id === String(id));
    // Audit trail: every permission granted or refused from the notch is recorded.
    if (request && approvals.decide(request.id, decision)) {
      const what = request.type === 'question' ? 'question' : `${request.kind}: ${request.detail.replace(/\s+/g, ' ').slice(0, 200)}`;
      log(`From notch: ${decision} ${what} for session ${request.sessionId}`);
    }
  });
  // Answers are validated against the question's form in the main process.
  ipcMain.handle('question:answer', (_e, id, answer) => {
    if (!approvals) return false;
    const ok = approvals.answer(String(id), answer);
    log(`Question ${id} answered from notch: ${ok ? 'sent to Copilot' : 'rejected (did not match the form)'}`);
    return ok;
  });
  // Typing an answer needs keyboard focus, which notch windows don't take by default.
  ipcMain.on('notch:request-typing', (e) => {
    const n = notches.notchFor(e.sender);
    if (n) startTyping(BrowserWindow.fromWebContents(e.sender));
  });
  // Empty name (or Copilot's own name) resets to Copilot's name.
  ipcMain.on('session:rename', (_e, id, name) => {
    id = String(id);
    const session = latest.find((s) => s.id === id) || (watcher && watcher.endedSessions.find((s) => s.id === id));
    if (!session) return;
    const clean = cleanName(name);
    setLabel(id, { name: clean === session.name ? '' : clean });
  });
  ipcMain.on('notch:rename-done', () => {
    renaming = false;
    endTypingIfDone();
  });
  ipcMain.on('notch:drag', (e, phase) => {
    const n = notches.notchFor(e.sender);
    if (!n) return;
    if (phase === 'start') notches.dragStart(n);
    else if (phase === 'move') notches.dragMove(n);
    else if (phase === 'end') {
      const offset = notches.dragEnd(n);
      if (offset !== null) settings.set({ offsetX: offset });
    } else if (phase === 'cancel') n.dragging = false;
    else if (phase === 'reset') settings.set({ offsetX: 0 });
  });
  ipcMain.on('notch:rect', (e, rect) => {
    const n = notches.notchFor(e.sender);
    if (n) n.hoverRect = rect;
  });
  ipcMain.on('menu:show', (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    if (window) popupMenu(buildMenu(), window);
  });
  ipcMain.on('pet:pointer', (e, phase, type, point) => {
    if (!pet.isPetWindow(e.sender) || !['down', 'move', 'up', 'cancel'].includes(phase)) return;
    const valid = point && Number.isFinite(point.x) && Number.isFinite(point.y);
    pet.pointer(e.sender, phase, ['touch', 'pen'].includes(type) ? type : 'mouse', valid ? { x: point.x, y: point.y } : null);
  });
  ipcMain.on('pet:ready', (e, info) => {
    if (pet.isPetWindow(e.sender)) pet.setReducedMotion(!!(info && info.reducedMotion));
  });
  // From the cat window or its carry overlay; anything else is ignored inside.
  ipcMain.on('pet:painted', (e) => pet.painted(e.sender));
  ipcMain.on('pets:open', () => openPetSettings());
  ipcMain.handle('pets:sessions', () => petSessions());
  ipcMain.on('pets:set-species', (_e, sessionId, species) => {
    const id = String(sessionId);
    if (!/^[\w-]{1,64}$/.test(id) || !latest.some((s) => s.id === id)) return;
    if (species !== null && !Object.keys(SPECIES_NAMES).includes(species)) return;
    setPetSpecies(id, species);
  });
  ipcMain.on('pet:menu', (e) => {
    const info = pet.info(e.sender);
    if (info) popupMenu(buildPetMenu(info), info.window);
  });
  ipcMain.on('session:menu', (e, id) => showSessionMenu(String(id), BrowserWindow.fromWebContents(e.sender)));
  ipcMain.on('ended:menu', (e, id) => showEndedMenu(String(id), BrowserWindow.fromWebContents(e.sender)));
  // Only paths this session actually reported can be revealed; never arbitrary renderer input.
  ipcMain.on('file:reveal', (_e, sessionId, filePath) => {
    const session = latest.find((s) => s.id === sessionId);
    const known = session && session.files && session.files.list.some((f) => f.path === filePath && f.kind !== 'deleted');
    if (!known) return;
    if (fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    else if (fs.existsSync(path.dirname(filePath))) shell.openPath(path.dirname(filePath));
  });
  ipcMain.handle('sessions:get-ended', () => endedWithLabels());
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  // Required for toast notifications on Windows; unpackaged builds use the electron.exe path.
  // Keeps the original app ID (from when the app was Copilot Notch): notifications, the login item
  // and installer upgrades are tied to it.
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  log = createLogger(logFile());
  settings.on('change', applySettings);
  enableAutoStartOnFirstRun();
  repointLaunchAtLogin();
  // A tray/menu-bar app: no Dock icon on macOS.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  updater = new Updater({ log, isPackaged: app.isPackaged, currentVersion: app.getVersion() });
  updater.on('change', onUpdateState);
  updater.configure({ feedUrl: settings.get().updateFeedUrl, auto: settings.get().autoUpdate });

  notches = new NotchManager({
    webPreferences,
    getSettings: () => settings.get(),
    onWindowCreated: (w) => forwardConsole(w, 'notch'),
  });
  notches.sync();
  pet = new PetManager({
    webPreferences,
    getSettings: () => settings.get(),
    getPerchRect: () => notches.perchRect(),
    onActivate: activatePet,
    isQuiet: () => settings.get().muteInFocusAssist && !!fullscreen && isQuiet(fullscreen.state),
    onWindowCreated: (w) => forwardConsole(w, 'pet'),
  });
  pet.sync();
  registerIpc();
  registerHotkey(settings.get().hotkey);
  syncApprovals(settings.get());

  tray = new Tray(trayImage(null, false));
  tray.setToolTip('Notch Picker');
  nativeTheme.on('updated', () => updateTray(JSON.parse(lastSentPayload || '[]')));
  git.on('change', () => refresh());
  tray.on('click', () => tray.popUpContextMenu(buildMenu()));
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));

  setInterval(() => notches.pollHover(), HOVER_POLL_MS);
  setInterval(() => notches.followCursor(), FOLLOW_CURSOR_MS);
  setInterval(() => refresh(), ALERT_TICK_MS);

  const resync = () => {
    notches.sync();
    notches.setHiddenDisplays(fullscreenDisplayIds());
    pet.setHiddenDisplays(fullscreenDisplayIds());
  };
  screen.on('display-metrics-changed', resync);
  screen.on('display-added', resync);
  screen.on('display-removed', resync);

  // Other topmost windows (e.g. the taskbar) can take z-order back; reassert periodically.
  setInterval(() => {
    notches.reassertTopmost();
    pet.reassertTopmost();
  }, 10000);

  fullscreen = new FullscreenMonitor({ log });
  fullscreen.on('change', (state) => {
    trackForeground(state);
    notches.setHiddenDisplays(fullscreenDisplayIds());
    pet.setHiddenDisplays(fullscreenDisplayIds());
    returnRequestsToTerminal(state.foreground).catch((e) => log(`Hand-back check failed: ${e.message}`));
  });
  // App windows (physical pixels) for roaming pets to walk on.
  fullscreen.on('windows', (wins) => {
    const toDip = (r) => (process.platform === 'win32' ? screen.screenToDipRect(null, r) : r);
    pet.setWindows(wins.map((w) => ({ id: w.id, cover: w.cover, ...toDip({ x: w.x, y: w.y, width: w.width, height: w.height }) })));
  });
  fullscreen.setWindowTracking(settings.get().pet && settings.get().petRoam);
  fullscreen.start();

  watcher = new SessionWatcher({ log });
  watcher.on('update', (sessions) => {
    latest = sessions;
    git.prune(sessions.map((s) => s.cwd).filter(Boolean));
    refresh();
  });
  watcher.on('ended', () => send('sessions:ended', endedWithLabels()));
  watcher.on('transition', (raw) => {
    if (isMuted(raw.session.id)) return;
    const t = { ...raw, session: applyLabel(raw.session, settings.get().sessionLabels) };
    send('sessions:transition', t);
    const primary = notches.primaryWindow();
    if (primary) primary.webContents.send('notch:announce', t);
    if (t.kind === 'done' || t.kind === 'error') {
      if (t.kind === 'done') pet.celebrate(t.session.id);
      else pet.startle(t.session.id);
      webhook(t.kind, t.session);
      if (settings.get().notifyOnDone) notify(t, { webhook: false });
    }
  });
  watcher.on('error', (e) => log(`[watcher] ${e && e.stack ? e.stack : e}`));
  log(`Notch Picker ${app.getVersion()} started (Electron ${process.versions.electron})`);
  if (process.argv.includes('--settings')) openSettings();
  if (process.argv.includes('--dashboard')) openDashboard();
  if (process.argv.includes('--pets')) openPetSettings();
  await watcher.start();
});

app.on('second-instance', (_e, argv) => {
  if (argv.includes('--settings')) openSettings();
  else if (argv.includes('--dashboard')) openDashboard();
  else if (argv.includes('--pets')) openPetSettings();
  else if (notches) notches.setUserHidden(false);
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  // Pending requests fall through to the terminal; the hook falls through while we're gone.
  if (approvals) approvals.stop();
  if (watcher) watcher.stop();
  if (fullscreen) fullscreen.stop();
});

// This is a tray app: notch windows come and go with display changes, so never auto-quit.
app.on('window-all-closed', () => {});
