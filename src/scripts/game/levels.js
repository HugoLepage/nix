// Level definitions. Speeds are in cells / second.
//
// { id, sparx: [{ speed, clockwise }], foes: [{ kind, ...overrides }], powerups: [type, …], intro }
// `kind` is 'qix' | 'chipper' | 'seeker' | 'spawner'; overrides (speed, radius, maxQix, interval) are optional and
// fall back to TUNING. `intro` names the one thing the level introduces (a foe kind, 'sparx' or a power type), or null.
// New things arrive one at a time; later levels mix a few of them rather than piling everything on.

const cw = (speed) => ({ speed, clockwise: true });
const ccw = (speed) => ({ speed, clockwise: false });
/** `n` foes of one kind, each its own object so nothing downstream shares state through the table. */
const foes = (n, kind, overrides = {}) => Array.from({ length: n }, () => ({ kind, ...overrides }));
const level = (id, sparx, foeList, powerups = [], intro = null) => ({ id, sparx, foes: foeList, powerups, intro });

export const LEVELS = [
  level(1, [], []),
  level(2, [cw(9)], [], [], 'sparx'),
  level(3, [ccw(10)], foes(1, 'qix'), [], 'qix'),
  level(4, [cw(10)], foes(2, 'qix')),
  level(5, [ccw(10)], foes(3, 'qix')),
  level(6, [cw(10)], foes(2, 'qix'), ['speed'], 'speed'),
  level(7, [cw(10), ccw(10)], foes(2, 'qix'), ['speed']),
  level(8, [cw(10)], [...foes(1, 'chipper'), ...foes(1, 'qix')], ['speed'], 'chipper'),
  level(9, [ccw(11)], foes(2, 'chipper'), ['speed']),
  level(10, [cw(11)], [...foes(1, 'chipper'), ...foes(2, 'qix')], ['shield'], 'shield'),
  level(11, [cw(11), ccw(11)], [...foes(1, 'chipper'), ...foes(1, 'qix')], ['shield', 'speed']),
  level(12, [cw(10)], [...foes(1, 'seeker'), ...foes(1, 'qix')], ['shield'], 'seeker'),
  level(13, [ccw(11)], [...foes(1, 'seeker'), ...foes(1, 'chipper'), ...foes(1, 'qix')], ['speed', 'shield']),
  level(14, [cw(11), ccw(11)], foes(2, 'seeker'), ['slow'], 'slow'),
  level(15, [cw(11)], [...foes(1, 'seeker'), ...foes(1, 'chipper'), ...foes(2, 'qix')], ['slow', 'shield']),
  level(16, [ccw(12)], [...foes(1, 'chipper'), ...foes(3, 'qix')], ['life', 'speed'], 'life'),
  level(17, [cw(12), ccw(12)], [...foes(2, 'seeker'), ...foes(1, 'qix')], ['life', 'slow']),
  level(18, [cw(11)], foes(1, 'spawner', { maxQix: 2 }), ['shield'], 'spawner'),
  level(19, [ccw(12)], [...foes(1, 'spawner'), ...foes(1, 'seeker')], ['slow', 'life']),
  level(20, [cw(12), ccw(12)], [...foes(1, 'spawner'), ...foes(1, 'qix')], ['freeze'], 'freeze'),
  level(21, [cw(12)], [...foes(1, 'spawner'), ...foes(1, 'chipper'), ...foes(1, 'seeker')], ['freeze', 'shield']),
  level(22, [cw(12), ccw(12)], [...foes(1, 'chipper'), ...foes(2, 'qix')], ['cut'], 'cut'),
  level(23, [ccw(12)], [...foes(2, 'seeker'), ...foes(1, 'chipper')], ['cut', 'speed']),
  level(24, [cw(13), ccw(13)], [...foes(1, 'spawner'), ...foes(1, 'chipper')], ['cut', 'freeze', 'life']),
  level(25, [cw(12), ccw(12)], [...foes(1, 'seeker'), ...foes(3, 'qix')], ['slow', 'shield', 'speed']),
  level(26, [ccw(13)], [...foes(2, 'chipper'), ...foes(1, 'seeker'), ...foes(1, 'qix')], ['freeze', 'cut']),
  level(27, [cw(13), ccw(13)], [...foes(1, 'spawner'), ...foes(1, 'seeker')], ['shield', 'slow', 'life']),
  level(28, [cw(13), ccw(13)], [...foes(2, 'chipper'), ...foes(2, 'qix')], ['cut', 'freeze', 'speed']),
  level(29, [cw(13), ccw(13), cw(13)], [...foes(1, 'spawner'), ...foes(2, 'seeker')],
    ['shield', 'slow', 'cut', 'life']),
  level(30, [cw(13), ccw(13)], [...foes(1, 'spawner', { maxQix: 2 }), ...foes(1, 'chipper'), ...foes(1, 'seeker')],
    ['speed', 'freeze', 'slow', 'shield', 'cut', 'life']),
];

export function getLevel(n) {
  return LEVELS.find((l) => l.id === n) || null;
}
