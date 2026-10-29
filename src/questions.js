'use strict';

// Answering Copilot CLI `ask_user` questions from the notch.
//
// A `preToolUse` hook (matcher `ask_user`) holds the tool call while the notch shows the form.
// When the user answers, the hook denies the tool call with a reason that carries the answer;
// the agent receives that text in place of the tool result. Anything else (timeout, "Terminal",
// an unsupported form) prints nothing, so the CLI shows its own prompt as usual.

const MAX_FIELDS = 6;
const MAX_OPTIONS = 12;
const MAX_TEXT = 4000;

function str(v, max = 500) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function optionsFrom(list, valueKey) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_OPTIONS) return null;
  const out = [];
  for (const o of list) {
    if (valueKey && o && typeof o === 'object' && typeof o[valueKey] === 'string') {
      out.push({ value: o[valueKey], label: str(o.title, 200) || o[valueKey] });
    } else if (!valueKey && (typeof o === 'string' || typeof o === 'number')) {
      out.push({ value: String(o), label: String(o).slice(0, 200) });
    } else return null;
  }
  return out;
}

function parseField(key, prop, required) {
  if (!prop || typeof prop !== 'object') return null;
  const base = {
    key,
    title: str(prop.title, 200) || key,
    description: str(prop.description, 400),
    required,
  };
  switch (prop.type) {
    case 'string': {
      const options = Array.isArray(prop.oneOf) ? optionsFrom(prop.oneOf, 'const') : Array.isArray(prop.enum) ? optionsFrom(prop.enum) : undefined;
      if (options === null) return null;
      if (options) {
        const def = options.some((o) => o.value === prop.default) ? prop.default : undefined;
        return { ...base, kind: 'choice', options, freeform: true, default: def };
      }
      return { ...base, kind: 'text', default: typeof prop.default === 'string' ? prop.default.slice(0, MAX_TEXT) : undefined };
    }
    case 'boolean':
      return { ...base, kind: 'boolean', default: typeof prop.default === 'boolean' ? prop.default : undefined };
    case 'number':
    case 'integer': {
      const field = { ...base, kind: 'number', integer: prop.type === 'integer' };
      if (Number.isFinite(prop.minimum)) field.min = prop.minimum;
      if (Number.isFinite(prop.maximum)) field.max = prop.maximum;
      if (Number.isFinite(prop.default)) field.default = prop.default;
      return field;
    }
    case 'array': {
      const items = prop.items || {};
      const options = Array.isArray(items.anyOf) ? optionsFrom(items.anyOf, 'const') : optionsFrom(items.enum);
      if (!options) return null;
      const values = new Set(options.map((o) => o.value));
      const def = Array.isArray(prop.default) ? prop.default.filter((v) => values.has(v)) : undefined;
      return { ...base, kind: 'multi', options, default: def };
    }
    default:
      return null;
  }
}

// Turns ask_user arguments into a form the notch can show, or null when it can't (the
// question then stays in the terminal). Supports the current `{ message, requestedSchema }`
// shape and the older `{ question, choices, allow_freeform }` one.
function parseQuestion(args) {
  if (!args || typeof args !== 'object') return null;
  if (args.requestedSchema && typeof args.requestedSchema === 'object') {
    const schema = args.requestedSchema;
    const props = schema.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
    const keys = Object.keys(props);
    if (keys.length === 0 || keys.length > MAX_FIELDS) return null;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = [];
    for (const key of keys) {
      const field = parseField(key, props[key], required.has(key));
      if (!field) return null;
      fields.push(field);
    }
    return { format: 'schema', message: str(args.message, 2000), fields };
  }
  const message = str(args.question || args.message, 2000);
  if (!message) return null;
  if (Array.isArray(args.choices) && args.choices.length) {
    const options = optionsFrom(args.choices);
    if (!options) return null;
    const field = { key: 'answer', title: 'Answer', description: '', required: true, kind: 'choice', options, freeform: args.allow_freeform !== false };
    return { format: 'legacy', message, fields: [field] };
  }
  return { format: 'legacy', message, fields: [{ key: 'answer', title: 'Answer', description: '', required: true, kind: 'text' }] };
}

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

// Checks an answer from the renderer against the form. Returns the cleaned answer object, or
// null if it doesn't fit (wrong types, unknown choices, missing required fields).
function validateAnswer(question, raw) {
  if (!question || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const f of question.fields) {
    let v = raw[f.key];
    if (typeof v === 'string') v = v.trim();
    if (isEmpty(v)) {
      if (f.required) return null;
      continue;
    }
    switch (f.kind) {
      case 'choice':
        if (typeof v !== 'string' || v.length > MAX_TEXT) return null;
        if (!f.freeform && !f.options.some((o) => o.value === v)) return null;
        break;
      case 'text':
        if (typeof v !== 'string' || v.length > MAX_TEXT) return null;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return null;
        break;
      case 'number':
        if (typeof v === 'string') v = Number(v);
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        if (f.integer && !Number.isInteger(v)) return null;
        if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return null;
        break;
      case 'multi': {
        if (!Array.isArray(v)) return null;
        const allowed = new Set(f.options.map((o) => o.value));
        if (!v.every((x) => allowed.has(x))) return null;
        v = [...new Set(v)];
        break;
      }
      default:
        return null;
    }
    out[f.key] = v;
  }
  return out;
}

// What the agent reads instead of the ask_user result.
function answerMessage(question, answer) {
  const reply = question.format === 'legacy' ? JSON.stringify(answer.answer ?? '') : JSON.stringify(answer);
  return (
    'Not an error: the user answered this question in the Notch Picker app, so it was not shown in the terminal. ' +
    `Treat this as the user's reply to ask_user and continue. The user's answer: ${reply}`
  );
}

module.exports = { parseQuestion, validateAnswer, answerMessage, MAX_FIELDS, MAX_OPTIONS };
