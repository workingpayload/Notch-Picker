'use strict';

// Lyrics for now playing, from LRCLIB (https://lrclib.net: free, no key, synced LRC lyrics).
// The service follows the media monitor's track, looks it up once (debounced, so skipping through
// songs doesn't send a request per song), caches the answer on disk and emits 'change' with:
//   null                                         - no lyrics wanted for this track
//   { key, status: 'loading' }                   - looking it up
//   { key, status: 'none' }                      - nothing found (or LRCLIB kept failing)
//   { key, status: 'found', synced, instrumental, lines: [{ t, text }] }
// `t` is the line's start in ms (null for unsynced lyrics); an empty text is a gap in the song.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const API = 'https://lrclib.net/api';
const USER_AGENT = 'Notch Picker (https://github.com/workingpayload/Notch-Picker)';
const MAX_LINES = 400;
const MAX_LINE_CHARS = 200;
const MAX_RESPONSE_CHARS = 3_000_000;
// Windows' media session and LRCLIB often disagree on a track's length by a few seconds
// (Spotify reported 191.8 s for a song LRCLIB lists at 197 s).
const DURATION_TOLERANCE_MS = 10000;
const DEBOUNCE_MS = 800;
const REQUEST_TIMEOUT_MS = 10000;
// LRCLIB answers "server busy" now and then: try again later, then give up for this play.
const RETRY_MS = [15000, 60000, 300000];
const CACHE_MAX = 300;
const FOUND_TTL_MS = 30 * 864e5;
const MISSING_TTL_MS = 864e5;

function cleanText(s, max = MAX_LINE_CHARS) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// "[01:02.34][02:10.5]Line <01:02.50>word" -> [{ t: 62340, text: 'Line word' }, { t: 130500, ... }],
// sorted by time. Honours an [offset:+/-ms] tag; metadata tags ([ar:], [ti:], ...) are skipped.
function parseLrc(text) {
  if (typeof text !== 'string') return [];
  const stamp = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
  let offset = 0;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (off) {
      offset = Number(off[1]);
      continue;
    }
    const times = [];
    let rest = raw;
    let m;
    while ((m = stamp.exec(rest))) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      times.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac);
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue;
    const line = cleanText(rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, ''));
    for (const t of times) lines.push({ t, text: line });
  }
  lines.sort((a, b) => a.t - b.t);
  // A positive offset means the lyrics come earlier.
  return lines.slice(0, MAX_LINES).map((l) => ({ t: Math.max(0, l.t - offset), text: l.text }));
}

function plainLines(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map((l) => cleanText(l))
    .slice(0, MAX_LINES)
    .map((l) => ({ t: null, text: l }));
}

// "Song - Remastered 2011", "Song (feat. X)", 'Song (From "Film")', "Song [Explicit]" -> "Song".
const VERSION_WORDS = '\\b(?:remaster(?:ed)?|explicit|clean|radio edit|single version|album version|mono|stereo|deluxe|bonus track|edit)\\b';
function cleanTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with|from)\s[^)\]]*[)\]]/gi, '')
    .replace(new RegExp(`\\s*[([][^)\\]]*(?:${VERSION_WORDS})[^)\\]]*[)\\]]`, 'gi'), '')
    .replace(new RegExp(`\\s+-\\s+[^-]*(?:${VERSION_WORDS}|from\\s)[^-]*$`, 'i'), '')
    .replace(/\s+(?:feat\.?|ft\.?)\s.*$/i, '')
    .trim();
}

// Lower case, no accents or punctuation, so "Sex, Drugs, Etc." matches "Sex Drugs Etc".
function normalize(s) {
  return (typeof s === 'string' ? s : '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function artists(s) {
  return (typeof s === 'string' ? s : '')
    .split(/,|;|\/|&|\s+(?:feat\.?|ft\.?|featuring|x|and|with)\s+/i)
    .map(normalize)
    .filter(Boolean);
}

function primaryArtist(artist) {
  const first = (typeof artist === 'string' ? artist : '').split(/,|;|\/|&|\s+(?:feat\.?|ft\.?|featuring|x)\s+/i)[0];
  return (first || '').trim();
}

function titleMatches(a, b) {
  const x = normalize(cleanTitle(a));
  const y = normalize(cleanTitle(b));
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

function artistMatches(a, b) {
  const x = artists(a);
  const y = new Set(artists(b));
  return x.some((n) => y.has(n)) || (!!normalize(a) && normalize(a) === normalize(b));
}

// Score of an LRCLIB record for the playing track (higher is better), or -Infinity if it's not it.
function scoreCandidate(c, track) {
  if (!c || typeof c !== 'object') return -Infinity;
  if (!titleMatches(track.title, c.trackName) || !artistMatches(track.artist, c.artistName)) return -Infinity;
  const synced = typeof c.syncedLyrics === 'string' && c.syncedLyrics.trim() !== '';
  const plain = typeof c.plainLyrics === 'string' && c.plainLyrics.trim() !== '';
  if (!synced && !plain && c.instrumental !== true) return -Infinity;
  let score = synced ? 100 : plain ? 40 : 30;
  if (track.durationMs > 0 && Number(c.duration) > 0) {
    const diff = Math.abs(Number(c.duration) * 1000 - track.durationMs);
    if (diff > DURATION_TOLERANCE_MS) return -Infinity;
    score -= (diff / 1000) * 3;
  }
  if (track.album && normalize(cleanTitle(track.album)) === normalize(cleanTitle(c.albumName))) score += 8;
  return score;
}

function pickBest(results, track) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of Array.isArray(results) ? results : []) {
    const score = scoreCandidate(c, track);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// An LRCLIB record -> { synced, instrumental, lines } (null if it has nothing usable).
function toLyrics(c) {
  if (!c) return null;
  const synced = parseLrc(c.syncedLyrics);
  if (synced.some((l) => l.text)) return { synced: true, instrumental: false, lines: synced };
  const plain = plainLines(c.plainLyrics);
  if (plain.some((l) => l.text)) return { synced: false, instrumental: false, lines: plain };
  return c.instrumental === true ? { synced: false, instrumental: true, lines: [] } : null;
}

// Spotify's ads come through the media session like songs.
function isAd(media) {
  return /^(advertisement|spotify)$/i.test((media.title || '').trim()) || /^spotify$/i.test((media.artist || '').trim());
}

// Lyrics are looked up for Spotify only, unless `allPlayers` (browser titles are often messy).
function wantsLyrics(media, { allPlayers = false } = {}) {
  if (!media || !media.title || !media.artist || isAd(media)) return false;
  return allPlayers || /spotify/i.test(media.appId || media.app || '');
}

function trackKey(media) {
  return [media.title, media.artist, media.album].map((s) => (s || '').trim().toLowerCase()).join('\u0001');
}

class LyricsService extends EventEmitter {
  constructor({
    fetch,
    cacheFile = null,
    log = () => {},
    debounceMs = DEBOUNCE_MS,
    retryMs = RETRY_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
    now = Date.now,
  } = {}) {
    super();
    this.fetch = fetch;
    this.cacheFile = cacheFile;
    this.log = log;
    this.debounceMs = debounceMs;
    this.retryMs = retryMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.allPlayers = false;
    this.key = null;
    this.result = null;
    this.timer = null;
    this.controller = null;
    this.attempt = 0;
    this.saveTimer = null;
    this.cache = new Map(); // key -> { at, lyrics } (lyrics null: nothing found)
    this.loadCache();
  }

  get state() {
    return this.result;
  }

  setOptions({ allPlayers = false } = {}) {
    this.allPlayers = !!allPlayers;
  }

  // Called with the media monitor's state (or null) whenever it changes.
  track(media) {
    const key = wantsLyrics(media, { allPlayers: this.allPlayers }) ? trackKey(media) : null;
    if (key === this.key) return;
    this.cancel();
    this.key = key;
    this.attempt = 0;
    if (!key) return this.set(null);
    const hit = this.cacheGet(key);
    if (hit) return this.set(this.toState(key, hit.lyrics));
    this.set({ key, status: 'loading' });
    const track = { title: media.title, artist: media.artist, album: media.album || '', durationMs: media.durationMs || 0 };
    this.timer = setTimeout(() => this.lookup(key, track), this.debounceMs);
  }

  toState(key, lyrics) {
    return lyrics ? { key, status: 'found', ...lyrics } : { key, status: 'none' };
  }

  set(result) {
    if (JSON.stringify(result) === JSON.stringify(this.result)) return;
    this.result = result;
    this.emit('change', result);
  }

  async lookup(key, track) {
    this.timer = null;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const lyrics = await this.find(track, controller.signal);
      if (this.key !== key || controller.signal.aborted) return;
      this.cachePut(key, lyrics);
      this.set(this.toState(key, lyrics));
    } catch (e) {
      if (this.key !== key || controller.signal.aborted) return;
      const delay = this.retryMs[this.attempt++];
      this.log(`Lyrics lookup failed for "${track.title}": ${e.message}${delay === undefined ? '' : `; retrying in ${Math.round(delay / 1000)} s`}`);
      if (delay === undefined) this.set({ key, status: 'none' });
      else this.timer = setTimeout(() => this.lookup(key, track), delay);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  // Searches by title and artist, then by a cleaned-up title and the first artist. Throws only if
  // every request failed (so a busy server is retried, while "not found" is cached).
  async find(track, signal) {
    const enc = encodeURIComponent;
    const urls = [`${API}/search?track_name=${enc(track.title)}&artist_name=${enc(track.artist)}`];
    const loose = `${cleanTitle(track.title)} ${primaryArtist(track.artist)}`.trim();
    if (loose && loose !== `${track.title} ${track.artist}`) urls.push(`${API}/search?q=${enc(loose)}`);
    let answered = false;
    let error = null;
    for (const url of urls) {
      let data;
      try {
        data = await this.request(url, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        error = e;
        continue;
      }
      answered = true;
      const best = pickBest(Array.isArray(data) ? data : [], track);
      const lyrics = toLyrics(best);
      if (lyrics) return lyrics;
    }
    if (!answered && error) throw error;
    return null;
  }

  async request(url, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.any([signal, timeout]),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LRCLIB answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new Error('LRCLIB answer too large');
    return JSON.parse(text);
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.controller) this.controller.abort();
    this.controller = null;
  }

  stop() {
    this.cancel();
    this.key = null;
    this.set(null);
    this.flush();
  }

  // ---- Cache: in memory, oldest dropped first, mirrored to a JSON file ----

  cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return null;
    const ttl = hit.lyrics ? FOUND_TTL_MS : MISSING_TTL_MS;
    if (this.now() - hit.at > ttl) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  cachePut(key, lyrics) {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), lyrics });
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.scheduleSave();
  }

  loadCache() {
    if (!this.cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (!data || data.version !== 1 || !Array.isArray(data.entries)) return;
      for (const [key, entry] of data.entries.slice(-CACHE_MAX)) {
        if (typeof key !== 'string' || !entry || !Number.isFinite(entry.at)) continue;
        const lyrics = sanitizeLyrics(entry.lyrics);
        if (entry.lyrics && !lyrics) continue;
        this.cache.set(key, { at: entry.at, lyrics });
      }
    } catch {
      // missing or unreadable: start empty
    }
  }

  scheduleSave() {
    if (!this.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    clearTimeout(this.saveTimer);
    const pending = !!this.saveTimer;
    this.saveTimer = null;
    if (!this.cacheFile || !pending) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.cache] }));
      fs.renameSync(tmp, this.cacheFile);
    } catch (e) {
      this.log(`Could not save the lyrics cache: ${e.message}`);
    }
  }

  // Turning lyrics off forgets which songs were looked up.
  clearCache() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.cache.clear();
    if (this.cacheFile) fs.rmSync(this.cacheFile, { force: true });
  }
}

// Lyrics read back from the cache file are checked like fresh ones.
function sanitizeLyrics(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.lines)) return null;
  const synced = v.synced === true;
  const lines = v.lines
    .slice(0, MAX_LINES)
    .filter((l) => l && typeof l.text === 'string' && (synced ? Number.isFinite(l.t) && l.t >= 0 : true))
    .map((l) => ({ t: synced ? Math.round(l.t) : null, text: cleanText(l.text) }));
  if (v.instrumental === true) return { synced: false, instrumental: true, lines: [] };
  return lines.some((l) => l.text) ? { synced, instrumental: false, lines } : null;
}

module.exports = {
  LyricsService,
  parseLrc,
  plainLines,
  cleanTitle,
  normalize,
  primaryArtist,
  titleMatches,
  artistMatches,
  scoreCandidate,
  pickBest,
  toLyrics,
  isAd,
  wantsLyrics,
  trackKey,
  sanitizeLyrics,
};
