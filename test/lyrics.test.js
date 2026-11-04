'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LyricsService, parseLrc, cleanTitle, pickBest, wantsLyrics, toLyrics } = require('../src/lyrics');
const { lyricIndexAt } = require('../src/island');

const spotify = {
  appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
  title: 'Sex, Drugs, Etc.',
  artist: 'Beach Weather',
  album: 'Pineapple Sunrise',
  durationMs: 191784,
  status: 'playing',
};

const record = (extra = {}) => ({
  trackName: 'Sex, Drugs, Etc.',
  artistName: 'Beach Weather',
  albumName: 'Pineapple Sunrise',
  duration: 197,
  instrumental: false,
  plainLyrics: 'first line\nsecond line',
  syncedLyrics: '[00:01.00] first line\n[00:05.50] second line',
  ...extra,
});

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function until(service, predicate) {
  return new Promise((resolve) => {
    if (predicate(service.state)) return resolve(service.state);
    const on = (state) => {
      if (!predicate(state)) return;
      service.off('change', on);
      resolve(state);
    };
    service.on('change', on);
  });
}

test('LRC: several stamps per line, centiseconds and milliseconds, offset, word stamps and tags', () => {
  const lines = parseLrc('[ar:Band]\n[offset:+500]\n[00:10.5][01:00.25]chorus <00:10.70>here\n[00:02.123]intro\n[00:20.00]\nno stamp');
  assert.deepEqual(lines, [
    { t: 1623, text: 'intro' },
    { t: 10000, text: 'chorus here' },
    { t: 19500, text: '' },
    { t: 59750, text: 'chorus here' },
  ]);
  assert.deepEqual(parseLrc(null), []);
});

test('titles lose featuring, remaster, film and explicit tags', () => {
  assert.equal(cleanTitle('Song - Remastered 2011'), 'Song');
  assert.equal(cleanTitle('Song (feat. Someone)'), 'Song');
  assert.equal(cleanTitle('Kesariya (From "Brahmastra")'), 'Kesariya');
  assert.equal(cleanTitle('Song [Explicit]'), 'Song');
  assert.equal(cleanTitle('Song ft. X'), 'Song');
  assert.equal(cleanTitle('Song (Interlude)'), 'Song (Interlude)', 'other brackets stay');
  assert.equal(cleanTitle('Meditation (Credits)'), 'Meditation (Credits)', 'whole words only');
  assert.equal(cleanTitle('Love - Me'), 'Love - Me', 'a dash alone is part of the title');
});

test('the best record: synced, same song within 10 s, album match preferred', () => {
  const results = [
    record({ albumName: 'Chit Chat', duration: 197 }),
    record({ syncedLyrics: null, plainLyrics: null, instrumental: true, duration: 192 }),
    record({ duration: 197, id: 'pick' }),
    record({ artistName: 'Someone Else', duration: 192 }),
    record({ duration: 208, albumName: 'Pineapple Sunrise' }),
  ];
  assert.equal(pickBest(results, spotify).id, 'pick');
  assert.equal(pickBest([record({ duration: 230 })], spotify), null, 'too far off in length');
  assert.equal(pickBest([record({ trackName: 'Another Song' })], spotify), null);
  const instrumental = toLyrics(pickBest([record({ syncedLyrics: '', plainLyrics: '', instrumental: true })], spotify));
  assert.deepEqual(instrumental, { synced: false, instrumental: true, lines: [] });
  assert.equal(toLyrics(record({ syncedLyrics: '' })).synced, false, 'falls back to plain lyrics');
});

test('lyrics only for Spotify songs unless all players are on; never for ads', () => {
  assert.equal(wantsLyrics(spotify), true);
  assert.equal(wantsLyrics({ ...spotify, appId: 'MSEdge' }), false);
  assert.equal(wantsLyrics({ ...spotify, appId: 'MSEdge' }, { allPlayers: true }), true);
  assert.equal(wantsLyrics({ ...spotify, title: 'Advertisement', artist: '' }), false);
  assert.equal(wantsLyrics({ ...spotify, title: 'Brand', artist: 'Spotify' }), false);
  assert.equal(wantsLyrics(null), false);
});

test('the playing line is the last one that has started', () => {
  const lines = [{ t: 1000 }, { t: 5000 }, { t: 9000 }];
  assert.equal(lyricIndexAt(lines, 500), -1);
  assert.equal(lyricIndexAt(lines, 1000), 0);
  assert.equal(lyricIndexAt(lines, 8999), 1);
  assert.equal(lyricIndexAt(lines, 60000), 2);
  assert.equal(lyricIndexAt([], 1000), -1);
});

test('looks a track up once, then answers from the cache (also after a restart)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-'));
  const cacheFile = path.join(dir, 'lyrics-cache.json');
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return json(200, [record()]);
  };
  const service = new LyricsService({ fetch, cacheFile, debounceMs: 0 });
  service.track(spotify);
  assert.equal(service.state.status, 'loading');
  const found = await until(service, (s) => s && s.status === 'found');
  assert.equal(found.synced, true);
  assert.deepEqual(found.lines, [
    { t: 1000, text: 'first line' },
    { t: 5500, text: 'second line' },
  ]);
  assert.match(urls[0], /\/api\/search\?track_name=Sex%2C%20Drugs%2C%20Etc\.&artist_name=Beach%20Weather$/);

  service.track({ ...spotify, positionMs: 50000 });
  service.track(null);
  assert.equal(service.state, null);
  service.track(spotify);
  assert.equal(service.state.status, 'found', 'from memory');
  service.stop();
  assert.equal(urls.length, 1);

  const again = new LyricsService({ fetch, cacheFile, debounceMs: 0 });
  again.track(spotify);
  assert.equal(again.state.status, 'found', 'from the cache file');
  again.clearCache();
  assert.equal(fs.existsSync(cacheFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a busy server is retried; "not found" is remembered', async () => {
  let calls = 0;
  const busy = new LyricsService({
    fetch: async () => (++calls <= 1 ? json(503, { name: 'ServerOverloaded' }) : json(200, [record()])),
    debounceMs: 0,
    retryMs: [1],
  });
  busy.track(spotify);
  const found = await until(busy, (s) => s && s.status === 'found');
  assert.equal(found.lines.length, 2);
  assert.equal(calls, 2, 'the retry found it');

  const urls = [];
  const empty = new LyricsService({
    fetch: async (url) => {
      urls.push(url);
      return json(200, []);
    },
    debounceMs: 0,
  });
  const featuring = { ...spotify, title: 'Sex, Drugs, Etc. (feat. Someone)' };
  empty.track(featuring);
  await until(empty, (s) => s && s.status === 'none');
  empty.track(null);
  empty.track(featuring);
  assert.equal(empty.state.status, 'none');
  assert.equal(urls.length, 2, 'searched by title/artist and by the cleaned-up title, once');
  assert.match(urls[1], /\?q=Sex%2C%20Drugs%2C%20Etc\.%20Beach%20Weather$/);

  const failing = new LyricsService({ fetch: async () => json(503, {}), debounceMs: 0, retryMs: [] });
  failing.track(spotify);
  await until(failing, (s) => s && s.status === 'none');
});

test('skipping to another song drops the old answer', async () => {
  let release;
  const slow = new Promise((r) => (release = r));
  const service = new LyricsService({
    fetch: async (url) => {
      if (url.includes('Sex')) await slow;
      return json(200, url.includes('Sex') ? [record()] : [record({ trackName: 'Other', artistName: 'Band', duration: 0 })]);
    },
    debounceMs: 0,
  });
  service.track(spotify);
  await wait(5);
  service.track({ ...spotify, title: 'Other', artist: 'Band', album: '', durationMs: 0 });
  release();
  const state = await until(service, (s) => s && s.status === 'found');
  assert.match(state.key, /^other/);
  await wait(5);
  assert.match(service.state.key, /^other/);
});
