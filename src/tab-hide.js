'use strict';

// "Hide over tabs": the notch hangs from the top of the screen, right where browsers, terminals
// and editors draw their tabs. While such an app is in front with its tab strip under the pill,
// the notch on that display steps aside (unless a session needs you).

// Process names (lower case, without .exe) of apps that draw tabs along their top edge.
const TABBED_APPS = new Set([
  // Browsers
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'zen', 'floorp', 'librewolf',
  'waterfox', 'chromium', 'thorium', 'duckduckgo', 'iexplore',
  // Terminals
  'windowsterminal', 'tabby', 'wezterm-gui',
  // Code editors
  'code', 'code - insiders', 'cursor', 'windsurf', 'vscodium', 'zed', 'notepad++', 'sublime_text',
  'idea64', 'pycharm64', 'webstorm64', 'rider64', 'goland64', 'clion64', 'phpstorm64', 'rubymine64',
  'datagrip64', 'rustrover64', 'studio64', 'fleet',
  // Windows 11 apps with tabs
  'explorer', 'notepad',
]);

// Depth (DIP at "small" size) of the band along the top of the screen where a window's top edge
// puts its tabs under the pill.
const TAB_BAND = 40;
// Maximized windows can overhang the display edge slightly.
const EDGE_SLACK = 16;

function isTabbedApp(name) {
  return typeof name === 'string' && TABBED_APPS.has(name.toLowerCase());
}

// Displays whose notch should hide because the foreground app's tab strip is under the pill.
// app: process name; rect: its visible frame (DIP); notches: [{ displayId, bounds (display, DIP),
// pill: { x, width } (screen DIP), zoom }]; attention: a session needs you (the notch stays up).
function tabHiddenDisplayIds({ app, rect, notches, attention = false }) {
  const ids = new Set();
  if (attention || !rect || !isTabbedApp(app)) return ids;
  for (const { displayId, bounds, pill, zoom = 1 } of notches) {
    if (!bounds || !pill) continue;
    const bandBottom = bounds.y + TAB_BAND * zoom;
    const topNearEdge = rect.y >= bounds.y - EDGE_SLACK && rect.y < bandBottom;
    const belowBand = rect.y + rect.height > bandBottom;
    const overlapsPill = rect.x < pill.x + pill.width && rect.x + rect.width > pill.x;
    if (topNearEdge && belowBand && overlapsPill) ids.add(displayId);
  }
  return ids;
}

module.exports = { tabHiddenDisplayIds, isTabbedApp, TABBED_APPS, TAB_BAND };
