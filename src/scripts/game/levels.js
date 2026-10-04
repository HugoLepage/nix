// Level definitions. Speeds are in cells / second, radius in cells.
export const LEVELS = [
  { id: 1, sparx: [], qix: [] },
  { id: 2, sparx: [{ speed: 9, clockwise: true }], qix: [] },
  { id: 3, sparx: [{ speed: 10, clockwise: false }], qix: [{ speed: 10, radius: 1.3 }] },
];

export function getLevel(n) {
  return LEVELS.find((l) => l.id === n) || null;
}
