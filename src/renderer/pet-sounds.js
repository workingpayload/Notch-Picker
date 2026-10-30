'use strict';

// Pet calls synthesised with Web Audio (no sound files): meow, woof, oink, baa, a goat's bleat,
// quack, a bunny's squeak and thump, a fox's yip and robot beeps. kind 'alert' (a session needs
// you) calls twice; 'pet' (being petted) once, softer.
(function () {
  let ctx = null;

  function audio() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // A voice: an oscillator through a band-pass "mouth", with a pitch curve and a volume envelope.
  function voice(a, t0, { type = 'sawtooth', pitch, dur, band = 1200, q = 2, vibrato = 0, vibratoDepth = 0, volume = 0.18 }) {
    const osc = a.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(pitch[0], t0);
    pitch.slice(1).forEach((f, i) => osc.frequency.linearRampToValueAtTime(f, t0 + (dur * (i + 1)) / (pitch.length - 1)));
    if (vibrato) {
      const lfo = a.createOscillator();
      const depth = a.createGain();
      lfo.frequency.value = vibrato;
      depth.gain.value = vibratoDepth;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + dur);
    }
    const filter = a.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = band;
    filter.Q.value = q;
    const gain = a.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + Math.min(0.04, dur / 4));
    gain.gain.setValueAtTime(volume, t0 + dur * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(filter).connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // A short puff of noise (the breathy part of a bark or grunt).
  function noise(a, t0, { dur, band, volume = 0.12 }) {
    const buffer = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buffer;
    const filter = a.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = band;
    const gain = a.createGain();
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(a.destination);
    src.start(t0);
  }

  const CALLS = {
    cat: (a, t, v) => voice(a, t, { pitch: [520, 820, 760, 480], dur: 0.5, band: 1400, q: 3, volume: v }),
    duck: (a, t, v) => {
      voice(a, t, { type: 'square', pitch: [560, 470], dur: 0.16, band: 1300, q: 4, volume: v * 0.8 });
      noise(a, t, { dur: 0.12, band: 1600, volume: v * 0.3 });
      voice(a, t + 0.2, { type: 'square', pitch: [540, 440], dur: 0.18, band: 1300, q: 4, volume: v * 0.8 });
    },
    bunny: (a, t, v) => {
      voice(a, t, { type: 'sine', pitch: [1100, 1500, 1200], dur: 0.12, band: 1400, q: 1, volume: v });
      noise(a, t + 0.18, { dur: 0.08, band: 180, volume: v * 0.9 });
    },
    fox: (a, t, v) => {
      voice(a, t, { pitch: [650, 1150, 700], dur: 0.17, band: 1500, q: 3, volume: v });
      voice(a, t + 0.24, { pitch: [700, 1250, 760], dur: 0.15, band: 1500, q: 3, volume: v });
    },
    robot: (a, t, v) => {
      voice(a, t, { type: 'square', pitch: [880, 880], dur: 0.08, band: 1600, q: 1, volume: v * 0.7 });
      voice(a, t + 0.12, { type: 'square', pitch: [1320, 1320], dur: 0.08, band: 1600, q: 1, volume: v * 0.7 });
      voice(a, t + 0.24, { type: 'square', pitch: [990, 660], dur: 0.12, band: 1600, q: 1, volume: v * 0.7 });
    },
    dog: (a, t, v) => {
      voice(a, t, { type: 'square', pitch: [260, 170], dur: 0.13, band: 800, q: 1.5, volume: v });
      noise(a, t, { dur: 0.1, band: 1000, volume: v * 0.6 });
      voice(a, t + 0.2, { type: 'square', pitch: [240, 150], dur: 0.13, band: 800, q: 1.5, volume: v });
      noise(a, t + 0.2, { dur: 0.1, band: 1000, volume: v * 0.6 });
    },
    pig: (a, t, v) => {
      voice(a, t, { pitch: [170, 120], dur: 0.14, band: 650, q: 5, volume: v });
      noise(a, t, { dur: 0.12, band: 500, volume: v * 0.4 });
      voice(a, t + 0.18, { pitch: [180, 130], dur: 0.16, band: 650, q: 5, volume: v });
    },
    sheep: (a, t, v) => voice(a, t, { pitch: [330, 310, 290], dur: 0.7, band: 1100, q: 2, vibrato: 7, vibratoDepth: 28, volume: v }),
    goat: (a, t, v) => voice(a, t, { pitch: [460, 430, 400], dur: 0.55, band: 1500, q: 2, vibrato: 12, vibratoDepth: 40, volume: v }),
  };

  function play(species, kind) {
    const call = CALLS[species] || CALLS.cat;
    const a = audio();
    const t = a.currentTime + 0.02;
    if (kind === 'alert') {
      call(a, t, 0.2);
      call(a, t + 0.85, 0.2);
    } else call(a, t, 0.12);
  }

  globalThis.PetSounds = { play, species: Object.keys(CALLS) };
})();
