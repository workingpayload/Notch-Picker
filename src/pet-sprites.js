'use strict';

// Pixel-art pets (cat, dog, pig, sheep, goat, duck, bunny, fox, robot) for the desktop pet. Frames are drawn fill-only on a 20×16 grid, facing right;
// outline() adds a one-pixel outline around every filled pixel, and the renderer mirrors frames
// for a cat facing left.
//   o fur  d darker fur (stripes)  w white  p pink (inner ear)  n nose  e eye  k outline/line
//   c collar: the session's colour tag, or the neck's colour when there is none

// Wrapped so that, loaded as a classic <script>, its names don't become page globals.
(function () {
  const SPRITE_W = 20;
  const SPRITE_H = 16;

  const STAND = [
    '....................',
    '....................',
    '....................',
    '.............o...o..',
    '..o..........poooop.',
    '..o.........ooooooo.',
    '..o.........ooeoeoo.',
    '..o.........oownwoo.',
    '..o.........occcco..',
    '...oooooooooooowwo..',
    '...oodoodoodoooww...',
    '...ooooooooooooo....',
    '....owwwwwwwwwoo....',
    '.....o.o....o.o.....',
    '.....w.w....w.w.....',
    '....................',
  ];

  function rowsWith(base, replacements) {
    const rows = base.slice();
    for (const [i, row] of Object.entries(replacements)) rows[Number(i)] = row;
    return rows;
  }

  const SPRITES = {
    stand: STAND,
    walk1: rowsWith(STAND, { 14: '....w...w....w......' }),
    walk2: rowsWith(STAND, { 14: '......w.....w...w...' }),
    // Tail straight up, as when something needs you.
    alert: rowsWith(STAND, { 1: '..o.................', 2: '..o.................', 3: '..o..........o...o..' }),
    sit: [
      '....................',
      '....................',
      '...........o...o....',
      '...........poooop...',
      '..........ooooooo...',
      '..........ooeoeoo...',
      '..........oownwoo...',
      '...........occco....',
      '........oooowwwo....',
      '.......ooooowwwo....',
      '......oodooowwwo....',
      '......ooodoowwwo....',
      '......ooooooo.oo....',
      '.oooooooooooowow....',
      '.oo.....wwooww.w....',
      '....................',
    ],
    sleep: [
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '............o...o...',
      '.....ooooo..poooop..',
      '...ooooddoooooooooo.',
      '..oooooooooookookoo.',
      '..ooooooooooooownoo.',
      '..oooowwwwwwooooooo.',
      '....................',
    ],
    hang: [
      '....................',
      '...ww..........ww...',
      '...oo..........oo...',
      '...oo..o....o..oo...',
      '...oo..poooop..oo...',
      '...oo.oooooooo.oo...',
      '...oo.ooeooeoo.oo...',
      '...oo.oownnwoo.oo...',
      '...ooo.occcco.ooo...',
      '....oooooooooooo....',
      '....oooowwwwoooo....',
      '.....ooowwwwooo.....',
      '.....ooowwwwooo.o...',
      '......oo....oo..o...',
      '......ww....ww.o....',
      '....................',
    ],
    held: [
      '....................',
      '.......o....o.......',
      '.......poooop.......',
      '......oooooooo......',
      '......ooeooeoo......',
      '......oownnwoo......',
      '.......occcco.......',
      '.....oooooooooo.....',
      '.....o.oowwoo.o.....',
      '.....o.oowwoo.o.....',
      '.....w.oowwoo.w.....',
      '.......oooooo.......',
      '.......o....o..o....',
      '.......o....o.o.....',
      '.......w....w.o.....',
      '....................',
    ],
    scared: [
      '....................',
      '.oo.................',
      '.oo.................',
      '.oo....ooooo........',
      '.oo..ooooooooo......',
      '.oooooodoodooooo....',
      '..oooooooooooooo....',
      '...ooooooooooooo.o..',
      '....oo.....o.poooop.',
      '....oo.....ooooooo..',
      '....oo.....oewewo...',
      '....oo.....oonoo....',
      '....oo......oo......',
      '....oo......oo......',
      '....ww......ww......',
      '....................',
    ],
    jump: [
      '....................',
      '..............o...o.',
      '..............poooo.',
      '.............oooooo.',
      '.............ooeoeo.',
      '............ooownwo.',
      '.........ooooowwo.w.',
      '.o.....oooodoowo.w..',
      '..o..ooooodoooo.....',
      '...oooooooooooo.....',
      '...oooowwwww........',
      '..oo................',
      '.ow.................',
      '....................',
      '....................',
      '....................',
    ],
    fall: [
      '....................',
      '....................',
      '.o............o...o.',
      '.o............poooo.',
      '.o...........oooooo.',
      '..o..........ooeoeo.',
      '..ooooooooooooownwo.',
      '..ooodoodoodooowwo..',
      '..oooooooooooooo....',
      '..ow.owwwwwwo.wo....',
      '.w...........w......',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  };

  SPRITES.sitBlink = rowsWith(SPRITES.sit, { 5: '..........ookokoo...' });
  SPRITES.sitTail = rowsWith(SPRITES.sit, { 12: '.o....ooooooo.oo....', 13: '.ooooooooooooowow...' });
  SPRITES.happy = rowsWith(SPRITES.sit, { 5: '..........ookokoo...', 6: '..........pownwop...' });
  SPRITES.sleep2 = rowsWith(SPRITES.sleep, { 10: '....oooooo..poooop..', 11: '..ooooooddooooooooo.' });
  SPRITES.hang2 = rowsWith(SPRITES.hang, { 12: '...o.ooowwwwooo.....', 13: '...o..oo....oo......', 14: '....o.ww....ww......' });
  // Turned a quarter-turn counter-clockwise: a pet facing right with its feet against a wall on
  // its right, head up (the renderer mirrors it for the left wall). 20?16 becomes 16?20.
  function rotateCCW(rows) {
    const h = rows.length;
    const w = rows[0].length;
    const out = [];
    for (let r = 0; r < w; r++) {
      let line = '';
      for (let c = 0; c < h; c++) line += rows[c][w - 1 - r];
      out.push(line);
    }
    return out;
  }

  SPRITES.held2 = rowsWith(SPRITES.held, { 12: '....o..o....o.......', 13: '.....o.o....o.......', 14: '......w......w......' });

  function rotate180(rows) {
    return rows.map((r) => [...r].reverse().join('')).reverse();
  }

  // Backflip: the standing pose a quarter-turn at a time (counter-clockwise pitches a pet facing
  // right backwards). The quarter-turned frames are 16×20, like the climbing ones.
  function flipFrames(stand) {
    return { flip1: rotateCCW(stand), flip2: rotate180(stand), flip3: rotateCCW(rotate180(stand)) };
  }
  Object.assign(SPRITES, flipFrames(STAND));

  // Climbing a screen edge: the walking frames on their side.
  SPRITES.climb1 = rotateCCW(SPRITES.walk1);
  SPRITES.climb2 = rotateCCW(SPRITES.walk2);
  SPRITES.cling = rotateCCW(SPRITES.stand);

  // Each frame is [sprite, dy] (dy in sprite pixels, negative = up). fps 0 shows the first frame.
  const ANIMS = {
    sit: { fps: 1, frames: [['sit', 0], ['sit', 0], ['sit', 0], ['sitBlink', 0], ['sit', 0], ['sitTail', 0], ['sit', 0]] },
    walk: { fps: 6, frames: [['walk1', 0], ['stand', -1], ['walk2', 0], ['stand', -1]] },
    run: { fps: 12, frames: [['walk1', 0], ['stand', -1], ['walk2', 0], ['stand', -1]] },
    // Hobbling after repeated errors: an uneven, slow step.
    limp: { fps: 5, frames: [['walk1', 0], ['stand', 0], ['walk2', 0], ['walk2', 0], ['stand', -1], ['stand', 0]] },
    sleep: { fps: 1, frames: [['sleep', 0], ['sleep2', 0]] },
    alert: { fps: 8, frames: [['alert', 0], ['alert', -2], ['alert', -3], ['alert', -2], ['alert', 0], ['alert', 0], ['alert', 0], ['alert', 0]] },
    happy: { fps: 3, frames: [['happy', 0], ['happy', -1]] },
    celebrate: { fps: 8, frames: [['happy', 0], ['happy', -2], ['happy', -4], ['happy', -2]] },
    // A finished todo list: a backflip, then a happy bounce.
    party: {
      fps: 10,
      frames: [['stand', 0], ['stand', -2], ['flip1', -4], ['flip2', -4], ['flip3', -4], ['stand', -2], ['stand', 0], ['happy', 0], ['happy', -2], ['happy', 0]],
    },
    scared: { fps: 10, frames: [['scared', 0], ['scared', -1]] },
    hang: { fps: 1, frames: [['hang', 0], ['hang2', 0]] },
    held: { fps: 6, frames: [['held', 0], ['held2', 0]] },
    jump: { fps: 0, frames: [['jump', 0]] },
    fall: { fps: 0, frames: [['fall', 0]] },
    climb: { fps: 6, frames: [['climb1', 0], ['cling', 0], ['climb2', 0], ['cling', 0]] },
    cling: { fps: 0, frames: [['cling', 0]] },
  };

  const PALETTES = {
    orange: { o: '#f2a04a', d: '#d0732a', w: '#fff3e2', p: '#f6a5b3', n: '#e35d77', e: '#2a1a0e', k: '#3a2212', c: '#fff3e2' },
    grey: { o: '#a9afba', d: '#7b828f', w: '#f4f5f7', p: '#f2a7b6', n: '#d65f77', e: '#1f4d2c', k: '#24282f', c: '#f4f5f7' },
    black: { o: '#34343e', d: '#25252d', w: '#5a5a66', p: '#b8627a', n: '#c46a7d', e: '#ffd23f', k: '#0b0b0e', c: '#5a5a66' },
    white: { o: '#f6f3ec', d: '#e0dace', w: '#ffffff', p: '#f5a9b8', n: '#e57890', e: '#3b6fd1', k: '#55505c', c: '#ffffff' },
  };

  // Other species: five hand-drawn poses each (same grid and colour letters as the cat); the
  // rest (walking legs, blinking, swinging legs) is derived in speciesSprites().
  const SPECIES_POSES = {
    dog: {
      stand: [
        '....................',
        '....................',
        '....................',
        '............ooooo...',
        '...........doooood..',
        '..o........doeoeod..',
        '..o........dowwwod..',
        '..o........d.wnw.d..',
        '...o.........ccc....',
        '...oooooddddoooww...',
        '...ooooooddooooww...',
        '...oooooooooooooo...',
        '....owwwwwwwwwoo....',
        '.....o.o....o.o.....',
        '.....w.w....w.w.....',
        '....................',
      ],
      sit: [
        '....................',
        '....................',
        '...........ooooo....',
        '..........doooood...',
        '..........doeoeod...',
        '..........dowwwod...',
        '..........d.wnw.d...',
        '............ccc.....',
        '........oooowwwo....',
        '.......ooooowwwo....',
        '......ooddoowwwo....',
        '..o...oooddowwwo....',
        '..o...ooooooo.oo....',
        '...ooooooooooowow...',
        '......wwooowww.w....',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '............ooooo...',
        '....ooooo..dooooood.',
        '..oooodddoodokoko.d.',
        '.oooooooooodowwwo.d.',
        '.ooooooooooodwnwd...',
        '.oooowwwwwwoooooo...',
        '....................',
      ],
      hang: [
        '....................',
        '...ww..........ww...',
        '...oo..........oo...',
        '...oo...oooo...oo...',
        '...oo.dooooood.oo...',
        '...oo.doeooeod.oo...',
        '...oo.dowwwwod.oo...',
        '...oo.d.wnnw.d.oo...',
        '...ooo..cccc..ooo...',
        '....oooooooooooo....',
        '....ooooddwwoooo....',
        '.....ooowwwwooo.....',
        '.....ooowwwwooo.o...',
        '......oo....oo..o...',
        '......ww....ww.o....',
        '....................',
      ],
      held: [
        '....................',
        '........oooo........',
        '.......doooood......',
        '......ddoeeoodd.....',
        '......ddowwwodd.....',
        '......d.wwnww.d.....',
        '........cccc........',
        '.....oooooooooo.....',
        '.....o.oowwoo.o.....',
        '.....o.oowwoo.o.....',
        '.....w.oowwoo.w.....',
        '.......oooooo.......',
        '.......o....o..o....',
        '.......o....o.o.....',
        '.......w....w.o.....',
        '....................',
      ],
    },
    pig: {
      stand: [
        '....................',
        '....................',
        '....................',
        '............d...d...',
        '...........ooooooo..',
        '...........ooeoeoo..',
        '...........oopppoo..',
        '..oo.......ookpkoo..',
        '.o..o.......ccccc...',
        '..o.ooooooooooooo...',
        '....ooooooooooooo...',
        '....ooooooooooooo...',
        '....oddooooooooo....',
        '.....d.d....d.d.....',
        '.....k.k....k.k.....',
        '....................',
      ],
      sit: [
        '....................',
        '....................',
        '............d...d...',
        '...........ooooooo..',
        '...........ooeoeoo..',
        '...........oopppoo..',
        '...........ookpkoo..',
        '............ccccc...',
        '.........oooooooo...',
        '........ooooooooo...',
        '.......oooooooooo...',
        '..oo...oooooooooo...',
        '.o..o..ooooooo.oo...',
        '..o.ooooooooooodod..',
        '.......ddooodd..k...',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '.............d...d..',
        '.....ooooo..ooooooo.',
        '..o.ooooooooooooooo.',
        '.o.oooooooooookokop.',
        '..ooooooooooooopppp.',
        '..oooooooooooooookk.',
        '....................',
      ],
      hang: [
        '....................',
        '...kk..........kk...',
        '...oo..........oo...',
        '...oo..d....d..oo...',
        '...oo.oooooooo.oo...',
        '...oo.ooeooeoo.oo...',
        '...oo.oopppppo.oo...',
        '...oo.ookppkoo.oo...',
        '...ooo.occcco.ooo...',
        '....oooooooooooo....',
        '....oooooooooooo....',
        '.....ooooooooooo....',
        '.....oooooooooo.o...',
        '......oo....oo.o.o..',
        '......kk....kk..o...',
        '....................',
      ],
      held: [
        '....................',
        '.......d....d.......',
        '......oooooooo......',
        '......ooeooeoo......',
        '......oopppppo......',
        '......ookppkoo......',
        '.......occcco.......',
        '.....oooooooooo.....',
        '.....o.oooooooo.....',
        '.....o.oooooooo.....',
        '.....k.oooooooo.k...',
        '.......oooooo.......',
        '.......o....o..o....',
        '.......o....o.o.o...',
        '.......k....k..o....',
        '....................',
      ],
    },
    sheep: {
      stand: [
        '....................',
        '....................',
        '............www.....',
        '...........wwwww....',
        '..........dwdddwd...',
        '...........deded....',
        '...........ddddd....',
        '..w.w.w.w..wdndw....',
        '.wwwwwwwwwwwcccw....',
        '.wwwwwwwwwwwwwwww...',
        '.wwwwwwwwwwwwwwww...',
        '..wwwwwwwwwwwwwww...',
        '...wwwwwwwwwwwww....',
        '.....d.d....d.d.....',
        '.....d.d....d.d.....',
        '....................',
      ],
      sit: [
        '....................',
        '...........www......',
        '..........wwwww.....',
        '.........dwdddwd....',
        '..........deded.....',
        '..........ddddd.....',
        '..........wdndw.....',
        '.........wwcccww....',
        '.......wwwwwwwwww...',
        '......wwwwwwwwwww...',
        '.....wwwwwwwwwwww...',
        '..w..wwwwwwwwwwww...',
        '.www.wwwwwwwwwwww...',
        '..wwwwwwwwwwwwd.d...',
        '......dd...dd..d....',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '.............www....',
        '...w.w.w.w..wwwww...',
        '..wwwwwwwwwwdwdddwd.',
        '.wwwwwwwwwwwwdkdkd..',
        '.wwwwwwwwwwwwddddd..',
        '.wwwwwwwwwwwwwdnd...',
        '..wwwwwwwwwwwwww....',
        '....................',
      ],
      hang: [
        '....................',
        '...dd..........dd...',
        '...dd...wwww...dd...',
        '...dd..wwwwww..dd...',
        '...dd.dwddddwd.dd...',
        '...dd..ddeedd..dd...',
        '...dd..dddddd..dd...',
        '...dd..wddndw..dd...',
        '...ddwwwccccwwwdd...',
        '....wwwwwwwwwwww....',
        '...wwwwwwwwwwwwww...',
        '...wwwwwwwwwwwwww...',
        '....wwwwwwwwwwww....',
        '......dd....dd.w....',
        '......dd....dd......',
        '....................',
      ],
      held: [
        '....................',
        '.......wwwwww.......',
        '......dwddddwd......',
        '.......ddeedd.......',
        '.......dddddd.......',
        '.......wddndw.......',
        '......wwccccww......',
        '....wwwwwwwwwwww....',
        '....dwwwwwwwwwwd....',
        '....dwwwwwwwwwwd....',
        '....dwwwwwwwwwwd....',
        '.....wwwwwwwwww.....',
        '.......d....d..w....',
        '.......d....d.......',
        '.......d....d.......',
        '....................',
      ],
    },
    goat: {
      stand: [
        '....................',
        '....................',
        '............d...d...',
        '...........dd...dd..',
        '............ooooo...',
        '...........ooeoeoo..',
        '..o.........ooooo...',
        '..o..........ono....',
        '...o.........www....',
        '...ooooooooooocwoo..',
        '...oooooooooooowo...',
        '...ooooooooooooo....',
        '....owwwwwwwwwoo....',
        '.....o.o....o.o.....',
        '.....d.d....d.d.....',
        '....................',
      ],
      sit: [
        '....................',
        '...........d...d....',
        '..........dd...dd...',
        '...........ooooo....',
        '..........ooeoeoo...',
        '...........ooooo....',
        '............ono.....',
        '............www.....',
        '........ooooowcoo...',
        '.......ooooooowoo...',
        '......oooooooooo....',
        '..o...oooooooooo....',
        '..o...ooooooo.oo....',
        '...oooooooooooodod..',
        '......wwoooww..d....',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '.............d...d..',
        '............dd...dd.',
        '.....ooooo...ooooo..',
        '...oooooooooookokoo.',
        '..o.oooooooooooooo..',
        '..ooooooooooooonow..',
        '..oooowwwwwwoooow...',
        '....................',
      ],
      hang: [
        '....................',
        '...dd.d......d.dd...',
        '...ooddd....dddoo...',
        '...oo..oooooo..oo...',
        '...oo.ooeooeoo.oo...',
        '...oo..oooooo..oo...',
        '...oo...oono...oo...',
        '...oo...wwww...oo...',
        '...ooo.occcwo.ooo...',
        '....oooooowooooo....',
        '....oooowwwwoooo....',
        '.....ooowwwwooo.....',
        '.....ooowwwwooo.o...',
        '......oo....oo..o...',
        '......dd....dd......',
        '....................',
      ],
      held: [
        '....................',
        '......ddd..ddd......',
        '.......oooooo.......',
        '......ooeooeoo......',
        '.......oooooo.......',
        '........oono........',
        '........wccw........',
        '.....ooooowoooo.....',
        '.....o.oowwoo.o.....',
        '.....o.oowwoo.o.....',
        '.....d.oowwoo.d.....',
        '.......oooooo.......',
        '.......o....o..o....',
        '.......o....o.o.....',
        '.......d....d.o.....',
        '....................',
      ],
    },
    duck: {
      stand: [
        '....................',
        '....................',
        '...........ooo......',
        '..........ooooo.....',
        '..........oooeo.....',
        '..........ooooonnn..',
        '...........oooonn...',
        '............ccc.....',
        '..o.........ooo.....',
        '..ooo......oooo.....',
        '..oooooooooooooo....',
        '...oodddddoooooo....',
        '....oooddddooooo....',
        '.....ooooooooo......',
        '........n...n.......',
        '....................',
      ],
      sit: [
        '....................',
        '....................',
        '....................',
        '...........ooo......',
        '..........ooooo.....',
        '..........oooeo.....',
        '..........ooooonnn..',
        '...........oooonn...',
        '............ccc.....',
        '..o.........ooo.....',
        '..ooo......oooo.....',
        '..oooooooooooooo....',
        '...oodddddoooooo....',
        '...ooooddddooooo....',
        '....oooooooooooo....',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '..o.......ooo.......',
        '..ooo....ooooo......',
        '..oooooooooeoonn....',
        '...oodddddoooooo....',
        '....oooooooooooo....',
        '....................',
      ],
      hang: [
        '....................',
        '...ww..........ww...',
        '...oo..........oo...',
        '...oo...oooo...oo...',
        '...oo..oooooo..oo...',
        '...oo..oeooeo..oo...',
        '...oo..oonnoo..oo...',
        '...oo...onno...oo...',
        '...ooo..cccc..ooo...',
        '....oooooooooooo....',
        '....oooddddddooo....',
        '.....oooddddooo.....',
        '......oooooooo......',
        '.......n....n.......',
        '......nn....nn......',
        '....................',
      ],
      held: [
        '....................',
        '........oooo........',
        '.......oooooo.......',
        '.......oeooeo.......',
        '.......oonnoo.......',
        '........nnnn........',
        '........cccc........',
        '.....oooooooooo.....',
        '....oo.oooooo.oo....',
        '....o..oddddo..o....',
        '.......oddddo.......',
        '.......oooooo.......',
        '........oooo........',
        '........n..n........',
        '.......nn..nn.......',
        '....................',
      ],
    },
    bunny: {
      stand: [
        '....................',
        '............oo.oo...',
        '............op.op...',
        '............op.op...',
        '............op.op...',
        '...........oooooo...',
        '...........ooooeoo..',
        '...........oooooon..',
        '............occco...',
        '.....ooooooooooo....',
        '...oooooooooooooo...',
        '..wooooooooooooo....',
        '.wwoodddooooooo.....',
        '..woooooooooooo.....',
        '....ooo.....oo......',
        '....................',
      ],
      sit: [
        '....................',
        '...........oo.oo....',
        '...........op.op....',
        '...........op.op....',
        '...........op.op....',
        '..........oooooo....',
        '..........ooooeoo...',
        '..........oooooon...',
        '...........occco....',
        '........ooooowwo....',
        '.......oooooowwo....',
        '......ooooooowwo....',
        '.....oooooooowwo....',
        '....wooooooooooo....',
        '....wwoooo..oooo....',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '..........oppoo.....',
        '....oooooooooooooo..',
        '...ooooooooooooooon.',
        '..wooooddoooooeoooo.',
        '.wwooooooooooooooo..',
        '..woooooooooooooo...',
        '....................',
      ],
      hang: [
        '....................',
        '...ww...o..o...ww...',
        '...oo...p..p...oo...',
        '...oo...o..o...oo...',
        '...oo.oooooooo.oo...',
        '...oo.ooeooeoo.oo...',
        '...oo.oooonooo.oo...',
        '...oo..occcco..oo...',
        '...ooo.oooooo.ooo...',
        '....oooooooooooo....',
        '....oooowwwwoooo....',
        '.....ooowwwwooo.....',
        '.....ooowwwwooo.ww..',
        '......oo....oo..w...',
        '......oo....oo......',
        '....................',
      ],
      held: [
        '....................',
        '.......o....o.......',
        '.......p....p.......',
        '.......o....o.......',
        '......oooooooo......',
        '......ooeooeoo......',
        '......ooonnooo......',
        '.......occcco.......',
        '.....oooooooooo.....',
        '.....o.oowwoo.o.....',
        '.....o.oowwoo.o.....',
        '.......oooooo.......',
        '.......oooooo.ww....',
        '.......o....o.......',
        '.......o....o.......',
        '....................',
      ],
    },
    fox: {
      stand: [
        '....................',
        '....................',
        '....................',
        '.............d...d..',
        '............doooood.',
        '............ooooooo.',
        '.ww.........ooeoeoo.',
        '.wwo........wwwnwww.',
        '..ooo........wcccw..',
        '...oooooooooooowwo..',
        '...ooooooooooooww...',
        '...ooooooooooooo....',
        '....owwwwwwwwwoo....',
        '.....d.d....d.d.....',
        '.....d.d....d.d.....',
        '....................',
      ],
      sit: [
        '....................',
        '....................',
        '...........d...d....',
        '..........doooood...',
        '..........ooooooo...',
        '..........ooeoeoo...',
        '..........wwwnwww...',
        '...........wcccw....',
        '........oooowwwo....',
        '.......ooooowwwo....',
        '......ooooooowwo....',
        '......ooooooowwo....',
        '.ww...ooooooo.oo....',
        '.wwooooooooooodod...',
        '..ooooooooodd..d....',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '............d...d...',
        '.....ooooo..doooood.',
        '...oooooooooooooooo.',
        '..ooooooooooooeoeoo.',
        '.wwoooooooooowwwnww.',
        '.wwwoooooooooooooo..',
        '....................',
      ],
      hang: [
        '....................',
        '...dd..........dd...',
        '...oo..........oo...',
        '...oo..d....d..oo...',
        '...oo..dooood..oo...',
        '...oo.oooooooo.oo...',
        '...oo.ooeooeoo.oo...',
        '...oo.wwwnnwww.oo...',
        '...ooo.wccccw.ooo...',
        '....oooooooooooo....',
        '....oooowwwwoooo....',
        '.....ooowwwwooo.....',
        '.....ooowwwwooo.oo..',
        '......dd....dd.ooo..',
        '......dd....dd..ww..',
        '....................',
      ],
      held: [
        '....................',
        '.......d....d.......',
        '.......dooood.......',
        '......oooooooo......',
        '......ooeooeoo......',
        '......wwwnnwww......',
        '.......wccccw.......',
        '.....oooooooooo.....',
        '.....o.oowwoo.o.....',
        '.....o.oowwoo.o.....',
        '.....d.oowwoo.d.....',
        '.......oooooo..oo...',
        '.......d....d.ooo...',
        '.......d....d.ooo...',
        '.......d....d..ww...',
        '....................',
      ],
    },
    robot: {
      stand: [
        '....................',
        '....................',
        '..............p.....',
        '..............d.....',
        '...........ooooooo..',
        '...........okkkkko..',
        '...........okekeko..',
        '...........okkkkko..',
        '...........ooooooo..',
        '..p..........ccc....',
        '...dooooooooooooo...',
        '....odndndndndnoo...',
        '....ooooooooooooo...',
        '.....d.d....d.d.....',
        '.....k.k....k.k.....',
        '....................',
      ],
      sit: [
        '....................',
        '..............p.....',
        '..............d.....',
        '...........ooooooo..',
        '...........okkkkko..',
        '...........okekeko..',
        '...........okkkkko..',
        '...........ooooooo..',
        '.............ccc....',
        '.........oooooooo...',
        '........odndndndo...',
        '.......ooooooooooo..',
        '..p....ooooooooooo..',
        '...dooooooooooodod..',
        '.......kkoooookk.k..',
        '....................',
      ],
      sleep: [
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '....................',
        '..............p.....',
        '..p..........ooooo..',
        '...d.........okeko..',
        '...dooooooooookkko..',
        '...odndndndndnoooo..',
        '...ooooooooooooooo..',
        '....................',
      ],
      hang: [
        '....................',
        '...kk..........kk...',
        '...dd....pp....dd...',
        '...dd....dd....dd...',
        '...dd.oooooooo.dd...',
        '...dd.okkkkkko.dd...',
        '...dd.okekkeko.dd...',
        '...dd.okkkkkko.dd...',
        '...dddooccccooddd...',
        '....oooooooooooo....',
        '....odndndndndno....',
        '.....oooooooooo.....',
        '.....oooooooooo..p..',
        '......dd....dd..d...',
        '......kk....kk......',
        '....................',
      ],
      held: [
        '....................',
        '.........pp.........',
        '.........dd.........',
        '......oooooooo......',
        '......okkkkkko......',
        '......okekkeko......',
        '......okkkkkko......',
        '......ooccccoo......',
        '.....oooooooooo.....',
        '.....d.odndndo.d....',
        '.....d.ooooooo.d....',
        '.....k.ooooooo.k....',
        '........ooooo.......',
        '........d...d.......',
        '........k...k..p....',
        '....................',
      ],
    },
  };
  // Two-legged: a duck waddles on its own two feet instead of the four-legged gait.
  SPECIES_POSES.duck.walk1 = rowsWith(SPECIES_POSES.duck.stand, { 14: '.......n.....n......' });
  SPECIES_POSES.duck.walk2 = rowsWith(SPECIES_POSES.duck.stand, { 14: '.........n.n........' });

  // Moves a row's filled pixels sideways (for swinging and kicking legs).
  function shiftRow(row, dx) {
    return dx > 0 ? '.'.repeat(dx) + row.slice(0, row.length - dx) : row.slice(-dx) + '.'.repeat(-dx);
  }

  // Walking feet in the standing pose's last two rows, using the species' own leg and foot colours.
  function walkRows(stand, feet) {
    const foot = stand[14].replace(/\./g, '')[0];
    return rowsWith(stand, { 14: feet.replace(/x/g, foot) });
  }

  // Full sprite set for a species from its poses, keyed "<species>.<pose>".
  function speciesSprites(species, poses) {
    const blink = (rows) => rows.map((r) => r.replace(/e/g, 'k'));
    const legs = (rows, from, dx) => rows.map((r, i) => (i >= from && i <= 14 ? shiftRow(r, dx) : r));
    const set = {
      stand: poses.stand,
      walk1: poses.walk1 || walkRows(poses.stand, '....x...x....x......'),
      walk2: poses.walk2 || walkRows(poses.stand, '......x.....x...x...'),
      sit: poses.sit,
      sitBlink: blink(poses.sit),
      sleep: blink(poses.sleep),
      hang: poses.hang,
      hang2: legs(poses.hang, 12, -1),
      held: poses.held,
      held2: legs(poses.held, 13, 1),
    };
    set.climb1 = rotateCCW(set.walk1);
    set.climb2 = rotateCCW(set.walk2);
    set.cling = rotateCCW(set.stand);
    Object.assign(set, flipFrames(set.stand));
    return Object.fromEntries(Object.entries(set).map(([k, v]) => [`${species}.${k}`, v]));
  }
  for (const [species, poses] of Object.entries(SPECIES_POSES)) Object.assign(SPRITES, speciesSprites(species, poses));

  // Animations for the other species, built from the cat's with these sprites standing in (the
  // cat has a few extra poses: tail-up alert, fright, mid-air).
  const SPECIES_STAND_IN = {
    sitTail: 'sit',
    happy: 'sitBlink',
    sleep2: 'sleep',
    alert: 'stand',
    scared: 'stand',
    jump: 'stand',
    fall: 'held',
  };

  const SPECIES = ['cat', 'dog', 'pig', 'sheep', 'goat', 'duck', 'bunny', 'fox', 'robot'];
  const SPECIES_NAMES = {
    cat: 'Cat',
    dog: 'Dog',
    pig: 'Pig',
    sheep: 'Sheep',
    goat: 'Goat',
    duck: 'Duck',
    bunny: 'Bunny',
    fox: 'Fox',
    robot: 'Robot',
  };

  const SPECIES_PALETTES = {
    dog: { o: '#c98b4f', d: '#7a4a26', w: '#f3e6d3', p: '#f29aa8', n: '#2b1d14', e: '#1e140d', k: '#2e1d10', c: '#f3e6d3' },
    pig: { o: '#f6b3c0', d: '#e08597', w: '#ffd9e0', p: '#ffcdd6', n: '#c25e72', e: '#2a1a1e', k: '#6e2f3c', c: '#f6b3c0' },
    sheep: { o: '#f4f1ea', d: '#2c2a2e', w: '#f7f5ef', p: '#f2a7b6', n: '#e08597', e: '#f4f1ea', k: '#4b4750', c: '#f7f5ef' },
    goat: { o: '#e2d6c0', d: '#6f6458', w: '#ffffff', p: '#f2a7b6', n: '#3a302a', e: '#3b2a14', k: '#4a3f35', c: '#e2d6c0' },
    // The duck's bill and feet use the nose colour.
    duck: { o: '#fbf7ec', d: '#d8cfb8', w: '#ffffff', p: '#f6a5b3', n: '#f39a2b', e: '#1d1a16', k: '#6b5a3a', c: '#fbf7ec' },
    bunny: { o: '#d9cbb8', d: '#b09c86', w: '#fbf8f3', p: '#f6a5b3', n: '#e57890', e: '#2a1d1d', k: '#5a4a3c', c: '#d9cbb8' },
    fox: { o: '#e8742c', d: '#3a2620', w: '#fff3e2', p: '#f6a5b3', n: '#2b1d14', e: '#2a1a0e', k: '#4a2412', c: '#fff3e2' },
    // The robot's face is a dark screen ('k') with glowing eyes; 'p' is its antenna light.
    robot: { o: '#b8c2cc', d: '#6c7a89', w: '#e8eef4', p: '#ff453a', n: '#40c8e0', e: '#40c8e0', k: '#2b3440', c: '#6c7a89' },
  };

  // Session colour tags (labels.js) as collar colours; same values as .tag-* in styles.css.
  const COLLAR_COLORS = {
    red: '#ff453a',
    orange: '#ff9f0a',
    yellow: '#ffd60a',
    green: '#30d158',
    teal: '#40c8e0',
    blue: '#0a84ff',
    purple: '#bf5af2',
    pink: '#ff375f',
  };

  // Sprite pixel size in DIPs for the pet size setting ('match' follows the notch's size preset).
  const PET_SIZE_CELL = { tiny: 2, small: 3, medium: 4, large: 5, huge: 6 };
  const NOTCH_SIZE_CELL = { tiny: 2, small: 3, normal: 4 };
  function petCell(petSize, notchSize) {
    return (petSize === 'match' ? NOTCH_SIZE_CELL[notchSize] : PET_SIZE_CELL[petSize]) || 3;
  }

  // Frames of an animation for a species: [[spriteKey, dy], ...].
  function animFor(species, anim) {
    const a = ANIMS[anim] || ANIMS.sit;
    if (!SPECIES_POSES[species]) return a;
    return { fps: a.fps, frames: a.frames.map(([name, dy]) => [`${species}.${SPECIES_STAND_IN[name] || name}`, dy]) };
  }

  // Colours for a species; the cat's come from the chosen cat colour.
  function paletteFor(species, catColor) {
    return SPECIES_PALETTES[species] || PALETTES[catColor] || PALETTES.orange;
  }

  // Speech-bubble glyphs (7×7, fill-only like the cat) and their colours.
  const BUBBLES = {
    alert: { color: '#ffb020', frames: [['...x...', '...x...', '...x...', '...x...', '...x...', '.......', '...x...']] },
    question: { color: '#ff6b6b', frames: [['..xxx..', '.x...x.', '.....x.', '...xx..', '...x...', '.......', '...x...']] },
    heart: { color: '#ff5c8a', frames: [['.......', '.xx.xx.', 'xxxxxxx', 'xxxxxxx', '.xxxxx.', '..xxx..', '...x...'], ['.......', '.......', '..x.x..', '.xxxxx.', '..xxx..', '...x...', '.......']] },
    note: { color: '#7ee787', frames: [['...xx..', '...x.x.', '...x..x', '...x...', '.xxx...', 'xxxx...', '.xx....'], ['.......', '...xx..', '...x.x.', '...x..x', '.xxx...', 'xxxx...', '.xx....']] },
    zzz: {
      color: '#cfe0ff',
      frames: [
        ['....xxxx', '......x.', '.....x..', '....xxxx', 'xxxx....', '..x.....', '.x......', 'xxxx....'],
        ['........', '....xxxx', '......x.', '.....x..', '....xxxx', 'xxx.....', '.x......', 'xxx.....'],
      ],
    },
    dots: { color: '#c9a7ff', frames: [['.......', '.......', '.......', '.......', '.......', 'x..x..x', '.......'], ['.......', '.......', '.......', '.......', '.......', 'x..x...', '.......'], ['.......', '.......', '.......', '.......', '.......', 'x......', '.......']] },
    // Wellbeing nudges and level-ups.
    water: { color: '#5ac8fa', frames: [['...x...', '..xxx..', '.xxxxx.', 'xxxxxxx', 'xxxxxxx', '.xxxxx.', '..xxx..'], ['.......', '...x...', '..xxx..', '.xxxxx.', 'xxxxxxx', '.xxxxx.', '..xxx..']] },
    stretch: { color: '#7ee787', frames: [['x.....x', 'x..x..x', '.xxxxx.', '...x...', '...x...', '..x.x..', '.x...x.'], ['.x...x.', '.x.x.x.', '..xxx..', '...x...', '...x...', '..x.x..', '.x...x.']] },
    star: { color: '#ffd60a', frames: [['...x...', '...x...', 'xxxxxxx', '.xxxxx.', '..xxx..', '.xx.xx.', 'x.....x'], ['.......', '...x...', '.xxxxx.', '..xxx..', '..x.x..', '.......', '.......']] },
  };

  // The fetch ball (r red, h highlight, s shade), outlined like the pets.
  const BALL = ['.......', '..rrr..', '.rhrrr.', '.rrrrr.', '.rrrrs.', '..rss..', '.......'];
  const BALL_COLORS = { r: '#ff453a', h: '#ffd0cc', s: '#b8241c', k: '#4a1410' };

  // Level badge: a star, coloured by tier (see pet-stats.js), drawn above the pet's back.
  const BADGE = ['.......', '...x...', '.xxxxx.', '..xxx..', '..x.x..', '.......'];
  const BADGE_COLORS = { bronze: '#d08a4a', silver: '#d6dde5', gold: '#ffd60a' };
  const BADGE_OUTLINE = '#3a2a10';

  // A sweat drop beside the head while the session's context window is nearly full.
  const SWEAT = ['.x', 'xx', 'xx'];
  const SWEAT_COLOR = '#5ac8fa';

  // Where the head (for sweat), mouth (for a carried ball) and level badge (top-left of its grid)
  // are in a pose, in sprite pixels of a pet facing right. Poses without a spot don't show that
  // extra (climbing and flipping show none; hanging and held pets wear no badge).
  const ANCHORS = {
    stand: { head: [11, 3], mouth: [15, 9], badge: [5, 2] },
    sit: { head: [9, 2], mouth: [13, 8], badge: [1, 4] },
    sleep: { head: [12, 9], mouth: [16, 13], badge: [4, 4] },
    hang: { head: [6, 4], mouth: [9, 8] },
    held: { head: [6, 2], mouth: [9, 6] },
  };
  const ANIM_POSE = {
    sit: 'sit',
    happy: 'sit',
    celebrate: 'sit',
    walk: 'stand',
    run: 'stand',
    limp: 'stand',
    alert: 'stand',
    scared: 'stand',
    jump: 'stand',
    fall: 'stand',
    sleep: 'sleep',
    hang: 'hang',
    held: 'held',
  };
  function anchorFor(anim) {
    return ANCHORS[ANIM_POSE[anim]] || null;
  }

  // Adds a 1-px outline ('k') around filled pixels (4-neighbour), leaving existing fills untouched.
  function outline(rows) {
    const h = rows.length;
    const w = rows[0].length;
    const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] !== '.';
    return rows.map((row, y) =>
      [...row]
        .map((c, x) => (c !== '.' ? c : filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1) ? 'k' : '.'))
        .join('')
    );
  }

  function flip(rows) {
    return rows.map((r) => [...r].reverse().join(''));
  }

  // Adds a drop shadow ('s') below-right of filled pixels: keeps thin bubble glyphs (Z, ?, …)
  // readable on light backgrounds where a full outline would fill them in. Grows the grid by one.
  function shadow(rows) {
    const h = rows.length;
    const w = rows[0].length;
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? rows[y][x] : '.');
    const out = [];
    for (let y = 0; y <= h; y++) {
      let row = '';
      for (let x = 0; x <= w; x++) {
        const c = at(x, y);
        row += c !== '.' ? c : at(x - 1, y - 1) !== '.' ? 's' : '.';
      }
      out.push(row);
    }
    return out;
  }

  // The cat's window, in sprite pixels: the 20×16 sprite is drawn bottom-centred, with room for
  // speech bubbles above its head and beside it while it hangs from the notch.
  const WIN_COLS = 32;
  const WIN_ROWS = 24;
  const SPRITE_X = (WIN_COLS - SPRITE_W) / 2;
  const SPRITE_Y = WIN_ROWS - SPRITE_H;
  const MAX_HOP = 4; // highest jump in ANIMS (dy)
  const BUBBLE_MAX = 9; // glyph plus its shadow

  // Top-left cell of a w×h bubble: above the head (on the side the cat faces), or beside a
  // hanging cat, since above it is the notch. spriteTop is the sprite's top row this frame.
  function bubbleOrigin(anim, facing, spriteTop, w, h) {
    if (anim === 'hang') return { x: WIN_COLS - w, y: SPRITE_Y + 5 };
    if (anim === 'climb' || anim === 'cling') return { x: facing < 0 ? WIN_COLS - w : 0, y: 0 };
    return { x: facing < 0 ? 0 : WIN_COLS - w, y: Math.max(0, spriteTop + 2 - h) };
  }

  // Window areas (in sprite pixels) that accept mouse, touch and pen input and are drawn; the
  // rest of the window is click-through. Covers the cat at any hop height and its bubble, and the
  // whole box while an effect (confetti) is drawn around the pet.
  function hitRects({ anim, facing, bubble, effect }) {
    if (effect) return [{ x: 0, y: 0, width: WIN_COLS, height: WIN_ROWS }];
    const rects = [{ x: SPRITE_X, y: SPRITE_Y - MAX_HOP, width: SPRITE_W, height: SPRITE_H + MAX_HOP }];
    if (bubble) {
      const top = bubbleOrigin(anim, facing, SPRITE_Y - MAX_HOP, BUBBLE_MAX, BUBBLE_MAX);
      const bottom = bubbleOrigin(anim, facing, SPRITE_Y, BUBBLE_MAX, BUBBLE_MAX);
      rects.push({ x: top.x, y: top.y, width: BUBBLE_MAX, height: bottom.y + BUBBLE_MAX - top.y });
    }
    return rects;
  }

  const api = {
    SPRITE_W,
    SPRITE_H,
    WIN_COLS,
    WIN_ROWS,
    SPRITE_X,
    SPRITE_Y,
    SPRITES,
    rotateCCW,
    ANIMS,
    PALETTES,
    SPECIES,
    SPECIES_NAMES,
    SPECIES_PALETTES,
    COLLAR_COLORS,
    BUBBLES,
    BALL,
    BALL_COLORS,
    BADGE,
    BADGE_COLORS,
    BADGE_OUTLINE,
    SWEAT,
    SWEAT_COLOR,
    animFor,
    anchorFor,
    paletteFor,
    petCell,
    outline,
    flip,
    shadow,
    bubbleOrigin,
    hitRects,
  };
  // Shared by the main process / tests (require) and the sandboxed pet renderer (<script>).
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.PetSprites = api;
})();
