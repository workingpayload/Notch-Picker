'use strict';

// Mascots shown next to the model name. Images live in src/renderer/mascots/ (made from the
// claude/codex/gemini mascot files in the project root: background removed, cropped, 96 px).
// Shared by tests (require) and the sandboxed notch renderer (<script>).

const FAMILIES = {
  claude: { label: 'Claude', test: /claude|anthropic|opus|sonnet|haiku/ },
  gemini: { label: 'Gemini', test: /gemini|google/ },
  // All OpenAI models (GPT, Codex, o-series) get the Codex mascot.
  codex: { label: 'Codex', test: /codex|gpt|openai|^o\d/ },
};

function modelFamily(model) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return null;
  for (const [family, { test }] of Object.entries(FAMILIES)) if (test.test(m)) return family;
  return null;
}

// Path relative to src/renderer/index.html.
function mascotImage(family) {
  return FAMILIES[family] ? `mascots/${family}.png` : '';
}

function familyLabel(family) {
  return FAMILIES[family] ? FAMILIES[family].label : '';
}

{
  const api = { modelFamily, mascotImage, familyLabel, FAMILIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.NotchMascots = api;
}
