'use strict';

const $ = (id) => document.getElementById(id);
let days = 7;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

function shortDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function bars(listEl, items, label, value, title) {
  listEl.replaceChildren();
  if (!items.length) {
    listEl.append(el('li', 'empty', 'No usage in this range'));
    return;
  }
  const max = Math.max(...items.map(value), 1);
  for (const item of items) {
    const li = el('li');
    const name = el('span', 'name', label(item));
    if (title) name.title = title(item);
    const meter = el('i', 'meter');
    const fill = el('b');
    fill.style.width = `${(value(item) / max) * 100}%`;
    meter.append(fill);
    li.append(name, el('span', 'value', fmt(value(item))), meter);
    listEl.append(li);
  }
}

async function render() {
  for (const b of document.querySelectorAll('.range button')) b.setAttribute('aria-checked', String(Number(b.dataset.days) === days));
  const data = await window.notchApi.getUsage(days);

  $('t-premium').textContent = fmt(Math.round(data.totals.premium * 10) / 10);
  $('t-sessions').textContent = fmt(data.totals.sessions);
  $('t-prompts').textContent = fmt(data.totals.prompts);
  $('t-tokens').textContent = fmt(data.totals.outputTokens);

  const chart = $('chart');
  const max = Math.max(...data.daily.map((d) => d.premium), 1);
  chart.replaceChildren(
    ...data.daily.map((d) => {
      const bar = el('div', d.premium ? 'bar' : 'bar zero');
      bar.style.height = `${(d.premium / max) * 100}%`;
      bar.title = `${shortDay(d.day)}: ${fmt(Math.round(d.premium * 10) / 10)} premium · ${d.prompts} prompts · ${d.sessions} sessions`;
      return bar;
    })
  );
  const busiest = data.daily.reduce((a, b) => (b.premium > a.premium ? b : a), data.daily[0]);
  chart.setAttribute(
    'aria-label',
    `Premium requests per day over ${days} days. Total ${fmt(data.totals.premium)}. Busiest day ${shortDay(busiest.day)} with ${fmt(busiest.premium)}.`
  );
  $('chart-axis').replaceChildren(el('span', null, shortDay(data.daily[0].day)), el('span', null, shortDay(data.daily[data.daily.length - 1].day)));

  bars($('folders'), data.folders, (f) => `${f.folder} (${f.sessions})`, (f) => f.premium, (f) => f.cwd || f.folder);
  bars($('models'), data.models, (m) => m.model, (m) => m.premium);
  bars($('sessions'), data.sessions, (s) => s.name, (s) => s.premium, (s) => `${s.cwd || ''}\n${s.prompts} prompts`);

  const q = data.quota;
  $('quota').textContent =
    q && !q.unlimited ? ` Account quota: ${Math.round(q.remainingPercentage)}% of ${q.entitlement.toLocaleString()} premium requests left this period.` : '';
}

for (const b of document.querySelectorAll('.range button')) {
  b.addEventListener('click', () => {
    days = Number(b.dataset.days);
    render();
  });
}

render();
