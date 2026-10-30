# Notch Picker

A Dynamic Island-style notch for Windows that shows the live status of your coding agent's sessions: GitHub Copilot CLI (default), Claude Code, Codex CLI or Gemini CLI.

## Choosing the agent

Pick the agent in *Settings → Agent* (or the tray's *Agent* submenu). The notch follows one agent at a time and switches immediately. Everything below (cards, pets, alerts, webhooks, colour tags, mute) works for every agent, with these differences:

| | Copilot CLI | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| Reads | `~/.copilot/session-state` | `~/.claude/sessions` + `~/.claude/projects` | `~/.codex/state_*.sqlite` + `~/.codex/sessions` | `~/.gemini/tmp/<project>/chats` |
| Live sessions | while the CLI runs | while the CLI runs | log written in the last 30 min | log written in the last 30 min |
| Approval / question waits | ✓ | ✓ (Claude Code 2.1+) | shown as a running tool | not logged |
| Running tools | ✓ | ✓ | ✓ | only once finished |
| "Done" | instantly | instantly | instantly | after ~6 s without new output (2 min if its last message announced more work); a slow tool can look finished |
| Usage | premium requests, quota, tokens, context | tokens | tokens, context | tokens |
| Click to open terminal | ✓ | ✓ | – | – |
| Approve & answer from the notch | ✓ | – | – | – |

Session titles come from the agent when it has one (Claude Code's `/rename`, Codex thread titles, Gemini summaries), otherwise the first prompt. *Copy resume command* gives `claude --resume <id>`, `codex resume <id>` or `gemini --resume <id>`. The folders follow `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GEMINI_CLI_HOME` when set. Nothing is installed into the other agents' configuration.

## WSL sessions

Copilot CLI sessions running inside WSL distros show up next to the Windows ones, with a **WSL** tag on their card (hover it for the distro). The notch reads `~/.copilot/session-state` in every home of each running distro through `\\wsl.localhost`, and checks that a session is live in the distro's own processes. Everything on the card works the same: status, todos, subagents, files changed, usage, alerts, pets, webhooks and *Recently ended*. For a WSL session:

- *Open folder* and clicking a changed file open it in Explorer through `\\wsl.localhost`; *Open folder in VS Code* opens it with VS Code's WSL extension.
- The git branch comes from git inside the distro.
- *Open terminal* can't trace a Linux process to its Windows window, so it brings forward a window connected to that distro: a VS Code window opened on it when the session runs in VS Code's terminal, otherwise a terminal running `wsl.exe` for it (by name, `--distribution-id` or as the default distro) or its launcher. With several, it picks the one whose title mentions the session's folder.
- *Copy resume command* gives `copilot --resume <id>`, to run inside the distro.
- Approving and answering from the notch isn't available: the hook is only installed for Copilot CLI on Windows, so WSL sessions ask in their terminal.

Reading a distro's files keeps WSL running, so the notch never starts a stopped distro, and reads a running one continuously only while it has a live Copilot session or a terminal open on it (`wsl.exe`, including Windows Terminal and VS Code, or a launcher such as `ubuntu2204.exe`). Otherwise it looks once every 30 seconds, and an unused distro still shuts down as usual. When a distro's terminal closes, as `wsl --shutdown` closes them all, the notch stops reading it until `wsl.exe` confirms it's still running. A session started some other way (e.g. over SSH) in a distro with no terminal open can take up to 30 seconds to appear. A `COPILOT_HOME` set inside the distro isn't followed, and the usage dashboard counts Windows sessions only. Turn it off with *Settings → Agent → Include WSL sessions*.

## What it shows

The pill hangs from the top-center of the primary display and stays on top. Clicks pass through it unless the cursor is over it.

| State | Look |
|---|---|
| Needs approval (shell / write / url / …) | amber, pulsing glow, the command or file |
| Waiting for your input (`ask_user`) | yellow, pulsing glow, the question |
| Running a tool | blue, tool name + command / file / pattern |
| Thinking | purple spinner, latest assistant message |
| Subagents working | cyan spinner, agent names |
| Error | red, error message |
| Done / Idle | green check briefly flashes when a turn finishes, then grey |

- **Collapsed:** status of the most urgent session (approval > input > working > idle) and elapsed time. In the classic style there is one dot per live session; in Dynamic Island style the next live activity pops out into a bubble instead (see below).
- **Hover:** expands to a card for each live session showing:
  - name, folder, git branch and elapsed time. The branch shows ↑/↓ for commits ahead of or behind upstream, and an amber ●N for changed files. Hover it for details.
  - your last prompt
  - **todo progress:** a bar with *done/total todos* and *Now: …*, the todo currently in progress, taken from the session's todo list.
  - subagent activity
  - a usage row: model, premium requests, output tokens and a context-window meter. The model has its family's mascot: Claude, Codex (all OpenAI models) or Gemini; other models show ✦. The mascot bobs while the session works and wiggles when it needs you. The images are in `src/renderer/mascots/`, made from the `*-mascot` files in the project root (background removed, cropped, 96 px).

  The header shows how much of your premium-request quota is left and when it resets (amber below 20%, red below 5%).
- **Recent activity:** each card has a collapsible list of the session's last five tool calls, with ✓/✕ results and durations. A running call shows a live timer.
- **Subagents:** a collapsible tree under the session (open automatically while agents are running). Each running subagent shows its model, elapsed time, number of tool calls and current step. The last five finished agents show ✓/✕, duration, tool calls and tokens.
- **Files changed:** a collapsible list of every file the session (including its subagents) created (+), edited (✎) or deleted (−), newest first, with edit counts and which subagent changed it. Click a file to show it in Explorer. Only edits that succeeded are counted. Files changed through shell commands aren't detected.
- **Click a card** to bring that session's terminal window to the front. This works with Windows Terminal, conhost and VS Code. In Windows Terminal it focuses the right window, but not a specific tab. For WSL sessions, see [WSL sessions](#wsl-sessions).
- **Right-click a card** (or use its **⋯** button) for:
  - *Open terminal*, *Open folder*, *Open folder in VS Code*
  - *Rename…*, *Reset name*, *Colour tag*
  - *Mute session*
  - *Copy resume command*, *Copy session ID*, *Open session-state folder* (other agents: *Show session log*)
- **Name and tag sessions:** *Rename…* turns the card's title into a text box (Enter saves, Esc cancels, empty goes back to Copilot's name). *Colour tag* gives the session one of eight colours: a stripe on its card, a swatch before its name, a ring around its dot in the pill, and a small bar in the collapsed pill when that session is the one shown. Your names appear everywhere the session does: cards, pill, notifications, webhooks, *Recently ended*. Hover a renamed card's title to see Copilot's name. Labels are stored in the notch's settings by session ID, so a resumed session keeps them; Copilot's own session files aren't changed.
- **Mute a session:** a muted session never takes over the pill, sends notifications, chimes or flashes. Its card is dimmed and moved to the bottom, and its dot is faded. Unmute it from the same menu.
- **Size:** *Tiny*, *Small* (default) or *Normal*, from the tray menu or Settings.
- **Multiple monitors:** *Show on* the primary display (default), the display with the cursor (the notch moves with you), or all displays.
- **Full-screen apps:** the notch hides on a monitor while a full-screen app (video, game, slideshow) is in front, and comes back afterwards. With Windows presentation mode on, it hides on every monitor. The chime is also silenced during Focus Assist / quiet hours. Both behaviours can be turned off in Settings.
- **Right-click** the notch or click the tray icon for *Hide from screen sharing*, *Notifications*, *Sound*, *Settings…*, *Launch at login*, *Open log* and *Quit*.
- **Tray icon:** the coloured dot shows the most urgent unmuted session (same colours as the notch). A red badge appears when a session is waiting for approval or input, so you can see status even when the notch is hidden. The pill turns dark on a light taskbar.
- **Pin expanded:** press **Ctrl+Alt+N** from anywhere, click the 📌 in the panel header, or use *Pin expanded* in the tray. The panel stays open without hovering and appears even if the notch is auto-hidden or hidden for a full-screen app. Press again to unpin. You can change the shortcut in Settings, or leave it empty to disable it. If another app already uses that combination, Settings says so.
- **Compact when idle** (off by default): when nothing is happening, the pill shrinks to a single status dot. It grows back as soon as a session is working or needs you. Hover the dot to expand it.
- **Auto-hide when idle** (off by default): the notch disappears 8 seconds after every unmuted session goes idle, giving the "Done" flash time to show. It comes back on any activity. It never vanishes while you're hovering it. The tray icon and hotkey still work while it's hidden.
- **Recently ended:** sessions that exit, or whose CLI crashes, while the notch is running are listed under *Recently ended* for 30 minutes, with their premium requests and todo progress. Click one to copy its `copilot --resume` command, open its folder, or remove it from the list. Resuming a session moves it back to the live list.
- **Position:** *Top center* (default), *Top left* or *Top right*. Drag the pill sideways by its top bar to fine-tune where it sits; the spot is remembered. Double-click the bar, or use *Position → Reset dragged offset*, to snap back.
- **Theme:** *Dark* (default), *Light*, or *Match Windows*, which follows your Windows app theme. *Opacity* (50–100%) makes the pill and panel background see-through. Status colours are adjusted for contrast in the light theme.

## Dynamic Island (on by default)

*Settings → Dynamic Island* turns each part on or off. With *Dynamic Island style* off, the notch keeps the classic flat pill.

- **Shape:** concave "shoulders" join the pill to the top edge of the screen. The collapsed pill shows the status on the left and the time or progress on the right, with an empty gap in the middle like a camera cut-out. Shape changes use a spring, and the pill squishes and its content un-blurs whenever what it shows changes.
- **Live activities:** a session that is working, a running timer, and music or video that is playing. The pill shows the most important one. The next one pops out into a small **bubble** beside it (+N when there are more); click the bubble to open that session's terminal, or to play/pause the media or timer. When no session is working, playing media takes over the pill with its cover and a waveform.
- **Waveform and progress ring:** a waveform while the agent thinks or media plays, and a ring for the session's todo progress or the timer.
- **Event banners:** when a session finishes, fails or needs you, a timer ends, charging starts, the battery runs low or the song changes, the pill grows into a card for a few seconds. It waits while the pointer is on it. Click it to open the session's terminal; swipe or scroll up to dismiss it. With banners off, events show as text in the pill as before.
- **Gestures:** scroll on the pill to switch which session it shows (its card is highlighted in the panel). Swipe down to open the panel, or pin it if it is already open. Swipe up to close it. Long-press to pin or unpin. *Open the panel on: Click* makes hovering only peek (the pill swells a little); click or swipe down to open it.
- **Now playing** (Windows): whatever is playing in any app that reports to Windows' media controls (Spotify, browsers, Media Player…): cover, title, artist, app, progress, and previous / play-pause / next buttons in the panel. A small PowerShell helper reads it; it only runs while the setting is on.
- **File shelf:** drag files or folders onto the notch (it lights up as a drop target) to keep them in the panel. Drag them out again into Explorer, a mail, a chat or an editor; click to open, right-click to show in folder, copy the path or remove. The shelf stores paths only (in `shelf.json` in the settings folder), and files that are moved or deleted drop off. Only folders, documents, images, audio/video and archives are opened; anything else (programs, scripts, shortcuts) is shown in its folder instead, so opening a shelf item never runs code.
- **Quick timer:** pick a timer (1 minute to 1 hour) or a stopwatch from the ⏱ button in the panel header or *Timer* in the notch / tray menu. It shows in the pill or the bubble and as a chip in the panel header (click to pause, right-click for more). When it ends you get a banner, a chime and a notification.
- **Battery banners:** when charging starts, and when the battery drops to 20%, 10% and 5%.
- Playing media and a running timer count as activity for *Compact when idle* and *Auto-hide when idle*.

## Desktop pets (off by default)

Turn on *Desktop pets* in the tray menu or *Settings → Desktop pets* for small pixel-art pets that react to your sessions: a **cat**, **dog**, **pig**, **sheep** or **goat**. Everything about them is in **Pet settings…** (tray menu, a pet's right-click menu, *Settings → Desktop pets*, or `npm start -- --pets`): a live preview of the five species at the chosen size and cat colour, and:

- **Size:** *Match the notch* (default) or *Tiny* to *Huge*, independent of the notch.
- **Speed:** *Lazy*, *Normal* or *Zippy* walking, running and climbing.
- **Activity:** *Calm*, *Normal* or *Playful*: how often they roam and play, and how soon they nap when idle.
- **Pet sounds** (off by default): a meow, woof, oink, baa or bleat when a pet's session needs you and when you pet it, made on the fly (no sound files). They need the notch's *Sound* setting on and stay quiet during Focus Assist. *Listen* buttons play each one.
- **Session pets:** every live session with its colour tag and a species picker (*Automatic* or a fixed species), plus which sessions have no pet because of the limit, or are asleep because they're muted.

- **One pet, or one per session:** *One pet for everything* (default) follows the most urgent session; pick its species in Settings or its menu. *One pet per session* gives each live session its own pet, up to *Most pets on screen* (5 by default, about 25–30 MB each); the sessions that most need you get pets first, and a session keeps its pet unless one that needs you turns up.
  - New sessions take the next species in turn (cat, dog, pig, sheep, goat). Change one with *Pet* in the session's ⋯ menu or the pet's own menu; the choice is remembered for that session.
  - A session's pet wears its **colour tag as a collar**, shows the **session's name on hover**, **sleeps while the session is muted**, and **walks off screen** when the session ends.
- **Mood:** a pet naps (💤) when its session (or everything) is idle, wanders and thinks (…) while Copilot works, and stands up with a **!** when a session needs approval or your answer. It hops with a ♪ when a turn finishes and jumps in fright on an error. Muted sessions don't affect the single pet.
- **Lives on:** *the taskbar* (walks along its top edge), *the notch* (hangs from the pill, even the compact dot), or *both* (default): pets stay on the taskbar and leap up to the notch when their session needs you, then drop back down. Several pets hang side by side along the pill, most urgent first; one that doesn't fit stays on the taskbar.
- **Roam the screen** (on by default): pets don't just walk the taskbar. They climb the screen's left and right edges, cling for a moment and let go; hop up onto app windows within reach and walk along their tops (riding along if you drag the window), and fall off the ends to whatever is below. Only the visible part of a window's top counts: maximized windows and windows in front hide the ones behind. They roam while idle or working, nap after a minute of idleness, and stay put (or leap to the notch) when their session needs you. Turn it off to keep them on the taskbar.
- **Play together** (on by default, with a pet per session): pets on the same surface now and then walk up to each other and swap hearts, play chase, or one curls up next to a sleeping one. A pet that falls or is tossed into another knocks it flying, and one that lands on another's head sits there and rides along.
- **Click a pet** while it shows **!** to bring that session's terminal to the front. Otherwise click or hover to pet it (it purrs with hearts).
- **Drag it** anywhere; let go and it falls back down. Toss it and it flies.
- **Touch screens and pens:** tap a pet to pet it (or, while it shows **!**, to open that terminal), rest a finger on it and it purrs, drag it with a finger, and press and hold for its menu. Only the pet itself takes clicks and touches; the rest of its little window passes them through to what's underneath.
- **Chase the mouse:** now and then a pet runs after the cursor when it's near the surface the pet is on. You can turn this off.
- **Right-click a pet** for *Open terminal* and *Pet* (species), *Pets* (one or per session), *Lives on*, *Cat colour* (orange tabby, grey, black, white), *Roam the screen*, *Play together*, *Chase the mouse*, *Pet settings…* and *Hide pets*.

Pets follow the notch's size preset, hide with full-screen apps, are hidden from screen sharing with the notch, and stay still with *reduce motion*. The sprites are drawn in code (`src/pet-sprites.js`); the behaviour is in `src/pet.js` and the windows in `src/pet-window.js`.

## Accessibility

- **Keyboard:** **Ctrl+Alt+N** (the pin hotkey) opens the panel and moves keyboard focus into it.
  - **↑/↓, Home/End** move between sessions; **Tab** reaches buttons, sections and files.
  - **Enter** opens the session's terminal; **Shift+F10** or the **Menu** key opens its actions; **F2** renames it.
  - **Esc** closes the panel and returns focus to the window you were in.
- **Screen readers:** Narrator and NVDA announce when a session needs approval or your answer (assertive), finishes, or errors. Cards, buttons and status marks have labels. With a notch on every display, each announcement is made once.
- **High contrast:** Windows contrast themes use system colours with visible borders, while status dots keep their colours. Animations respect *reduce motion*.

## Approve and answer from the notch (beta, off by default)

Approve or deny Copilot CLI permission requests (shell commands, file writes, URLs, …), and answer Copilot's questions, straight from the notch without switching to the terminal. Turn either on in *Settings → Approve & answer from the notch*.

How it works: the app adds supported Copilot CLI [hooks](https://docs.github.com/en/copilot/reference/hooks-configuration) at `~/.copilot/hooks/copilot-notch.json`: a `permissionRequest` hook for approvals and a `preToolUse` hook limited to `ask_user` for questions. For each request the hook asks the running notch; the card shows the command or file with **Approve**, **Deny** and **Terminal** buttons and a countdown.

**Questions (`ask_user`):** the card shows Copilot's question as a small form: choice chips (with an *Other…* box), multi-select, Yes/No, text and number fields. Click a text box and the notch takes keyboard focus; it hands focus back when the question is answered. **Send** passes your answer to Copilot (as the hook's reason text, which Copilot reads as your reply) and the terminal never shows the question. **Terminal**, the countdown running out (60 s by default), or forms too large for the notch (more than 6 fields, more than 12 options, nested objects) leave the question to the terminal as usual.

Safety:
- **You decide everything.** Nothing is approved or answered without your click. If you don't answer before the countdown ends (30 s for approvals by default), the request goes back to the normal terminal prompt.
- **Fails safe.** If the notch isn't running, crashes, or anything goes wrong, the hook steps aside and Copilot asks in the terminal as usual. It never denies or approves on error.
- **No accidental clicks.** The **Approve**, **Deny**, **Send** and **Terminal** buttons need the panel to have been still for 0.7 s and the mouse to *move onto* the button first. A cursor that happened to be where the box appeared can't approve, and neither can stray keystrokes. Keyboard approval works only in the Ctrl+Alt+N keyboard mode (or while typing an answer). Answers are checked against the question's form before they are sent.
- **Sandbox escapes** still need confirmation in the terminal (Copilot CLI enforces this).
- **Local only.** The hook talks to the app over `127.0.0.1` with a random per-run token.
- **Audit log.** Every decision is written to `notch.log`. Answers' contents are not logged.
- **Clean removal.** Turning both settings off, or uninstalling the app, removes the hook. Other hook files are never touched.

*Only when I'm away from that terminal* (on by default) sends requests and questions to the notch only while that session's terminal isn't the active window, and hands a held request back to the terminal as soon as you switch to it. If you're looking at the terminal, Copilot asks there as normal. A request held in the notch isn't auto-approved by Copilot's own rules, so leave this on unless you want every prompt in the notch. The hooks apply to sessions started after you turn a feature on.

## Usage dashboard

*Usage dashboard…* in the tray (or `npm start -- --dashboard`) shows the last 7, 30 or 90 days from your local session logs:
- premium requests per day
- totals for premium requests, sessions, prompts and output tokens
- breakdowns by folder, by model, and top sessions

Logs are re-read only when they change.

## Webhook

*Settings → Webhook* POSTs JSON to an `https://` URL, so you can get alerts on your phone through Slack, a Teams workflow, Discord or your own service.
- **Events:** needs approval/input, stuck or still waiting, errors, and optionally turn finished.
- **Body:** includes `text` and `content` fields, so Slack/Teams- and Discord-style receivers work.
- **Privacy:** by default only the session name and status are sent. Turn on *Include details* to also send commands, file paths and folders.
- **Testing:** use *Send test webhook* to check delivery.

## Alerts and privacy

- **Hidden from screen sharing by default.** The notch is excluded from Teams/Zoom shares, recordings and screenshots, but you still see it. You can turn this off in Settings or the tray menu.
- **Desktop notifications** when a session needs approval or input and you haven't answered within *N* seconds (default 5). Click a notification to jump to that session's terminal. A short chime plays as well; turn it off with the *Sound* setting.
- **Stuck detection:**
  - A tool running longer than 10 minutes turns orange ("Stuck?").
  - An approval or input waiting longer than 3 minutes pulses red.
  - Each case sends one reminder notification.
- **Optional "turn finished" notification** (off by default).

Windows Do Not Disturb (for example, during calls) sends notifications straight to Notification Center.

## Settings

Open *Settings…* from the tray, or run `npm start -- --settings`. Settings are saved to `%APPDATA%\copilot-notch\settings.json`. The diagnostics log is `%APPDATA%\copilot-notch\notch.log`. It records unknown Copilot CLI event types and terminals it couldn't find. If a session's events stop looking like the format this app understands, its card shows a warning.

## Install

The app icon (`build/icon.png`, `build/icon.ico`) is generated from the pet sprites by `python build/make-icon.py build` (needs Pillow).

```powershell
npm install
npm run dist         # builds dist\Notch-Picker-Setup-<version>.exe
```

Run the installer. It installs for the current user only, with no admin prompt, into `%LOCALAPPDATA%\Programs\notch-picker` (upgrades from Copilot Notch stay in its `copilot-notch` folder), adds a Start menu shortcut and starts the app. The first time the installed app runs, it turns on *Launch at login*; you can turn that off from the tray menu. To upgrade, run a newer installer. To remove it, use *Settings → Apps → Notch Picker*. Your settings in `%APPDATA%\copilot-notch` are kept (the folder keeps the app's original name, Copilot Notch, so settings carry over).

The installer isn't code-signed, so Windows SmartScreen may warn the first time. Choose *More info → Run anyway*.

**Code signing:** with a code-signing certificate, set `CSC_LINK` (path or base64 of the `.pfx`) and `CSC_KEY_PASSWORD` before `npm run dist`; electron-builder signs the app, the uninstaller and the installer, and records the publisher so auto-updates are only accepted when signed by the same publisher. (Verified with a throwaway self-signed certificate; a trusted certificate is still needed to avoid SmartScreen.) For a certificate in the Windows store or an HSM/Azure Trusted Signing, see electron-builder's [Windows code signing](https://www.electron.build/code-signing-win) options (`win.signtoolOptions` / `win.azureSignOptions`) in `package.json`.

## Releases (GitHub Actions)

`.github/workflows/release.yml` builds the installer on GitHub and publishes it as a release:

```powershell
npm version 1.18.0 --no-git-tag-version   # bump package.json (and the lockfile)
git commit -am "Release 1.18.0"
git tag v1.18.0
git push origin main --tags
```

The tag must match `version` in `package.json` (the workflow checks). It runs the tests on Windows, builds `Notch-Picker-Setup-<version>.exe`, and creates the **v1.18.0** release with the installer, its `.blockmap` and `latest.yml`, plus generated release notes. *Actions → Release → Run workflow* does a trial build without a release (download it from the run's artifacts). To sign the installer, add repository secrets `CSC_LINK` (base64 of the `.pfx`) and `CSC_KEY_PASSWORD`; without them it's built unsigned.

## Updates

The installed app can update itself from a **generic update feed**: any web folder holding the files `npm run dist` writes to `dist\` — `latest.yml`, `Notch-Picker-Setup-<version>.exe` and its `.blockmap` (for example a GitHub release's download folder or an internal file server).

1. Bump `version` in `package.json`, run `npm run dist`, and upload those three files to the feed folder.
2. In *Settings → Updates*, set *Update feed URL* (https; `http://localhost` also works for testing). With the GitHub releases above, use `https://github.com/workingpayload/Notch-Picker/releases/latest/download/`.

The app checks 30 s after start and every 6 hours (or *Check now* / *Check for updates* in the tray). With *Download updates automatically* on, a new version downloads in the background and installs the next time the app restarts; a notification and the tray's *Restart to update* do it immediately. Updates are off while no feed is set, and in `npm start` builds.

## Performance

Hardware acceleration is off by default: the notch is drawn in software, which uses about half the memory with no visible difference (measured: ~134 MB vs ~277 MB private memory across all processes). Turn it on in *Settings → Performance* if animations stutter; it takes effect after a restart. Installers include only the English Chromium locale (~48 MB smaller installed).

## macOS and Linux (experimental, untested)

The session watcher, notch UI, alerts, approvals/questions, webhooks, dashboard and updates are cross-platform, and `package.json` has build targets:

```bash
npm run dist:mac     # dmg + zip (zip is what macOS auto-update uses); build on a Mac
npm run dist:linux   # AppImage
```

What differs from Windows:
- **Click-to-focus a terminal, full-screen hiding, Focus Assist muting and the hotkey's focus hand-back** use Windows APIs and are skipped. Because the app can't tell which window is active, turn off *Only when I'm away from that terminal* if you use approvals or questions there.
- **macOS:** the app has no Dock icon and the notch shows on every Space, centered under the camera notch. Unsigned builds need *right-click → Open* the first time.
- **Linux:** transparency needs a compositing window manager; *Launch at login* isn't available.

## Run from source

```powershell
npm install
npm start            # or double-click start-notch.cmd (no console window)
```

The installed app and `npm start` share the same settings and only one runs at a time. Starting a second copy just brings the running notch back.

## How it works

Copilot CLI writes each session to `%USERPROFILE%\.copilot\session-state\<session-id>\` (or `%COPILOT_HOME%\session-state`):

- `inuse.<pid>.lock` — a session counts as live while that PID is a running `copilot.exe`/`node.exe` process.
- `workspace.yaml` — session name and working directory.
- `session.db` / `plan.md` — the session's todo list and plan. They are read only (SQLite, via Node's built-in `node:sqlite`) and re-read only when they change.
- `events.jsonl` — append-only event log. One recursive `fs.watch` on `session-state` re-reads only the session that changed, usually within a few hundred milliseconds. A slow polling pass covers any missed notifications. On startup only the last 8 MB is replayed in full; earlier lines are scanned once just for usage totals, so premium-request and token counts cover the whole session.

`src/session-state.js` is a pure reducer that turns events (`user.message`, `assistant.turn_*`, `tool.execution_*`, `permission.*`, `subagent.*`, `session.task_complete`, `abort`, `session.error`, `session.shutdown`, …) into a status. `src/watcher.js` discovers sessions and emits updates and transitions; `src/wsl.js` finds Copilot CLI sessions inside running WSL distros and decides when their files may be read. For the other agents, `src/agent-logs.js` translates Claude Code transcripts, Codex rollouts and Gemini chat logs into the same events (mapping their tool names, so details and changed files work), and `src/agent-watcher.js` finds each agent's live sessions and adds what its log lacks: Claude Code's own idle/waiting status, and Gemini's end of turn after a quiet period. `src/agents.js` lists the supported agents. `src/alerts.js` decides when to notify. `src/focus-terminal.ps1` finds and focuses a session's terminal window. `src/notches.js` manages one transparent, click-through window per target display. `src/todos.js` reads todo progress. `src/git-info.js` caches `git status` per folder: it refreshes every 15 s, runs at most two at a time, and uses `--no-optional-locks` so it never blocks your own git commands. `src/tray-icon.js` draws the status tray icon. `src/fullscreen-monitor.ps1` is a small background helper that reports full-screen apps, quiet hours and the WSL terminals open per distro; it exits automatically when the app does. `src/approval.js` runs the local endpoint the hooks (`src/hooks/permission-hook.js`) call; `src/questions.js` turns `ask_user` forms into notch fields and validates answers. `src/updater.js` wraps electron-updater. `src/main.js` ties everything together.

## Test

```powershell
npm test
```
"# Notch-Picker" 
