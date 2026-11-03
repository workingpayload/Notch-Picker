#!/usr/bin/env node
'use strict';

// Downloads the pet sounds from Openverse (https://openverse.org) into src/renderer/sounds/ and
// writes the attribution they need to CREDITS.md. The clips picked are pinned by Openverse id in
// sounds.json, so re-running re-downloads the same ones; pass --refresh to search again, or
// --refresh=cat,dog for just some species.
//
//   node scripts/fetch-pet-sounds.js [--refresh[=species,...]]

const fs = require('fs');
const path = require('path');

const API = 'https://api.openverse.org/v1/audio/';
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'sounds');
const MANIFEST = path.join(OUT, 'sounds.json');
const LICENSES = ['cc0', 'by']; // no share-alike or non-commercial terms on files shipped in the app
const MIN_MS = 250;
const MAX_MS = 3000;
const UA = 'NotchPicker/pet-sounds (+https://github.com/workingpayload/Notch-Picker)';

// Queries tried in order, and words a clip's title must (words) or must not (avoid) contain.
// Openverse tags are too loose to trust (dog barks tagged "fox", sheep tagged "goat"). A species
// with no good clip keeps its synthesised call (src/renderer/pet-sounds.js): at the time of
// writing there were no short fox or rabbit calls on Openverse.
const SPECIES = {
  cat: { queries: ['cat meow', 'kitten meow'], words: ['meow', 'miaow', 'mew'] },
  dog: { queries: ['dog bark', 'small dog bark'], words: ['bark', 'woof'] },
  pig: { queries: ['pig oink', 'pig grunt'], words: ['oink', 'grunt', 'snort'], avoid: ['scream'] },
  sheep: { queries: ['sheep baa', 'sheep bleat'], words: ['sheep', 'baa'], avoid: ['goat'] },
  goat: { queries: ['goat bleat', 'goat'], words: ['goat'], avoid: ['sheep'] },
  duck: { queries: ['duck quack', 'quack'], words: ['quack'], avoid: ['cartoon'] },
  bunny: { queries: ['rabbit squeak', 'bunny squeak', 'rabbit thump'], words: ['rabbit', 'bunny'], avoid: ['alien', 'growl', 'human'] },
  fox: { queries: ['fox bark', 'fox call', 'fox yip', 'fox'], words: ['fox'], avoid: ['demon', 'firefox'] },
  robot: { queries: ['robot beep', 'robot blip'], words: ['robot', 'beep', 'blip'] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { json = true, tries = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } });
    } catch (err) {
      if (attempt >= tries) throw err;
    }
    if (res && res.ok) return json ? res.json() : Buffer.from(await res.arrayBuffer());
    if (res && res.status < 500 && res.status !== 429) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    if (attempt >= tries) throw new Error(`${res ? res.status : 'network error'} for ${url}`);
    await sleep(1500 * attempt);
  }
}

function usable(item, { words, avoid = [] }) {
  const title = String(item.title || '').toLowerCase();
  return (
    LICENSES.includes(item.license) &&
    item.duration >= MIN_MS &&
    item.duration <= MAX_MS &&
    /\.mp3(\?|$)/i.test(item.url) &&
    words.some((w) => title.includes(w)) &&
    !avoid.some((w) => title.includes(w))
  );
}

// The best short clip for a species, or null if Openverse has none.
async function search(species) {
  const spec = SPECIES[species];
  for (const q of spec.queries) {
    // Freesound only: Openverse's other audio sources are mostly music and spoken words.
    const url = `${API}?q=${encodeURIComponent(q)}&license=${LICENSES.join(',')}&source=freesound&page_size=20`;
    const { results = [] } = await get(url);
    const hits = results.filter((item) => usable(item, spec));
    // Openverse's relevance order, CC0 first (no attribution needed).
    const best = hits.find((item) => item.license === 'cc0') || hits[0];
    if (best) return best;
  }
  return null;
}

function credit(item) {
  return {
    id: item.id,
    title: item.title,
    creator: item.creator,
    creator_url: item.creator_url || null,
    license: item.license,
    license_version: item.license_version || null,
    license_url: item.license_url,
    source: item.source,
    landing_url: item.foreign_landing_url,
    openverse_url: `https://openverse.org/audio/${item.id}`,
    attribution: item.attribution,
    duration_ms: item.duration,
    url: item.url,
  };
}

function licenseName({ license, license_version }) {
  return license === 'cc0' ? 'CC0 1.0' : `CC ${license.toUpperCase()} ${license_version || ''}`.trim();
}

function writeCredits(manifest) {
  const rows = Object.entries(manifest).map(([species, c]) => {
    const by = c.creator_url ? `[${c.creator}](${c.creator_url})` : c.creator;
    return `| ${species} | [${c.title.replace(/\|/g, '\\|')}](${c.landing_url}) | ${by} | [${licenseName(c)}](${c.license_url}) |`;
  });
  const md = [
    '# Pet sound credits',
    '',
    'The pet sounds were found with [Openverse](https://openverse.org) and are used unchanged under',
    'the licenses below. They are fetched by `npm run sounds` (`scripts/fetch-pet-sounds.js`).',
    '',
    '| Pet | Sound | By | License |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), md);
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--refresh'));
  const refresh = !arg ? new Set() : arg.includes('=') ? new Set(arg.split('=')[1].split(',')) : new Set(Object.keys(SPECIES));
  for (const s of refresh) if (!SPECIES[s]) throw new Error(`unknown species: ${s}`);

  fs.mkdirSync(OUT, { recursive: true });
  const old = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  const manifest = {};
  let failed = 0;

  for (const species of Object.keys(SPECIES)) {
    const file = path.join(OUT, `${species}.mp3`);
    try {
      const item = old[species] && !refresh.has(species) ? await get(`${API}${old[species].id}/`) : await search(species);
      if (!item) {
        fs.rmSync(file, { force: true });
        console.log(`${species.padEnd(6)} no clip on Openverse; keeps the synthesised call`);
        continue;
      }
      fs.writeFileSync(file, await get(item.url, { json: false }));
      manifest[species] = credit(item);
      console.log(`${species.padEnd(6)} ${licenseName(item).padEnd(10)} ${String(item.duration).padStart(5)}ms  ${item.title} — ${item.creator}`);
    } catch (err) {
      failed++;
      if (old[species]) manifest[species] = old[species];
      console.error(`${species.padEnd(6)} FAILED: ${err.message}`);
    }
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  writeCredits(manifest);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
