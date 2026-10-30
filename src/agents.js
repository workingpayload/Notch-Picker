'use strict';

// The coding agents Notch Picker can follow (one at a time, chosen in Settings).
// Shared by the main process (require) and the sandboxed renderers (<script>).

const AGENTS = {
  copilot: { label: 'Copilot', cli: 'Copilot CLI', command: 'copilot' },
  claude: { label: 'Claude Code', cli: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex', cli: 'Codex CLI', command: 'codex' },
  gemini: { label: 'Gemini', cli: 'Gemini CLI', command: 'gemini' },
};

const AGENT_IDS = Object.keys(AGENTS);

function agentInfo(id) {
  return AGENTS[id] || AGENTS.copilot;
}

function agentLabel(id) {
  return agentInfo(id).label;
}

// Command that reopens a session in a terminal.
function resumeCommand(agent, sessionId) {
  if (agent === 'codex') return `codex resume ${sessionId}`;
  return `${agentInfo(agent).command} --resume ${sessionId}`;
}

{
  const api = { AGENTS, AGENT_IDS, agentInfo, agentLabel, resumeCommand };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.NotchAgents = api;
}
