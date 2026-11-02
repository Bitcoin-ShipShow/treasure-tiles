// The cove, shared by the server (which decides where every ball lands) and the pages
// (which draw it). The scene is a painted 1920×1080 cove (public/art/cove.jpg): a sheer cliff
// on the left and across the back, with the puzzle picture painted on it as a mural (covered
// by rock slabs, the tiles); a lagoon in front where everyone's ship sails back and forth;
// and on the right a crescent beach with a rowdy pirate town.
//
// A shot is an angle (0 = straight at the cliff, negative = left, ±180 = straight back toward
// the viewer: a cannon can fire any way round) and a power (0..1). The ball flies across the
// water in the aimed direction, further with more power. If it runs out before the cliff it
// splashes into the lagoon (or lands on the beach). If it reaches the cliff, the leftover power
// carries it up the cliff face; too much and it sails over the top. Fired away from the cliff,
// it can only land in the lagoon, on the beach, or out of the picture.

export const MAX_ANGLE = 180;
export const SCENE = { w: 1920, h: 1080 };
const WATER = 600; // the foot of the cliff, where the painted lagoon begins
const MURAL = { cx: 918, cy: 325, maxW: 608, maxH: 532 }; // the picture: big, painted on the cliff above the waterline (right of the board's panel)
const REACH = 1.6; // full power travels this many scene heights
const CLIMB = 0.55; // how far up the cliff each unit of leftover travel carries the ball
const TOWN_X = 1180; // the town starts here (right side, above the waterline)

export interface Cove {
  w: number;
  h: number;
  pic: { x: number; y: number; w: number; h: number }; // where the picture sits on the cliff
  water: number; // y of the waterline at the foot of the cliff
}

/** The cove for a picture of this size: the picture is fitted onto the cliff panel. */
export function cove(picW: number, picH: number): Cove {
  const k = Math.min(MURAL.maxW / picW, MURAL.maxH / picH);
  const w = Math.round(picW * k);
  const h = Math.round(picH * k);
  return { w: SCENE.w, h: SCENE.h, pic: { x: Math.round(MURAL.cx - w / 2), y: Math.round(MURAL.cy - h / 2), w, h }, water: WATER };
}

/** Small steady random numbers per ship, so every page computes the same course. */
function seeded(slot: number, k: number) {
  const s = Math.sin((slot + 1) * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Where a ship is at a moment (seconds, server time). Each ship sails back and forth across
 * the lagoon in front of the cliff on its own lane, at its own speed. Nearer lanes are lower
 * on the screen, have more room, and are drawn bigger.
 */
export function shipAt(slot: number, t: number, c: Cove): { x: number; y: number; facing: 1 | -1; scale: number } {
  const lane = (slot * 0.618 + 0.15 * seeded(slot, 1)) % 1;
  const period = 45 + 40 * seeded(slot, 2);
  const phase = slot * 2.39996 + seeded(slot, 3);
  // ships sail back and forth close in front of the middle of the wall, so every ship has a
  // fair, straight-on shot at it
  const mid = c.pic.x + c.pic.w / 2;
  const span = c.pic.w * (0.16 + 0.1 * seeded(slot, 4));
  const a = (t / period) * Math.PI * 2 + phase;
  const x = mid + span * Math.sin(a);
  // out in open water, clear of the dock and the foot of the cliff
  const y = c.water + 75 + 85 * lane;
  return { x, y, facing: Math.cos(a) >= 0 ? 1 : -1, scale: 0.75 + 0.5 * lane };
}

export type Landing = { x: number; y: number; result: "wall" | "rock" | "town" | "short" | "over" | "wide" };

/** Where a ball lands. wind: -1..1 (pushes right when positive). */
export function landing(from: { x: number; y: number }, angle: number, power: number, wind: number, c: Cove): Landing {
  const a = (Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, angle)) * Math.PI) / 180;
  const p = Math.max(0, Math.min(1, power));
  const dx = Math.sin(a);
  const dy = Math.cos(a);
  const travel = p * REACH * c.h;
  // distance across the water to the foot of the cliff (never, when aimed away from it)
  const toCliff = dy > 0.001 ? (from.y - c.water) / dy : Infinity;
  const drift = wind * travel * 0.12;
  if (travel < toCliff) {
    const x = from.x + dx * travel + drift;
    const y = from.y - dy * travel;
    return { x, y, result: x < 0 || x > c.w || y > c.h ? "wide" : "short" };
  }
  const x = from.x + dx * toCliff + drift;
  const y = c.water - (travel - toCliff) * CLIMB;
  if (x < 0 || x > c.w) return { x, y, result: "wide" };
  if (y < 0) return { x, y: -c.h * 0.05, result: "over" };
  const { pic } = c;
  if (x >= pic.x && x <= pic.x + pic.w && y >= pic.y && y <= pic.y + pic.h) return { x, y, result: "wall" };
  return { x, y, result: x > TOWN_X ? "town" : "rock" };
}

/** Is a point inside a polygon? */
export function inPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Things around the cove that react when a cannonball lands near them (for fun, no points).
 * Positions are in scene units; every page decides the reaction from the same landing point,
 * so every screen agrees.
 */
export type PropKind =
  | "palm" | "toucan" | "chest" | "rum" | "drunk" | "dancer" | "kraken"
  | "crab" | "parrot" | "monkey" | "mermaid" | "hammock" | "cannon"
  // these move around on their own
  | "shark" | "rowboat" | "seagull" | "bottle" | "turtle"
  // parts of the painting itself (nothing extra drawn; they shout back and puff/spark)
  | "bonfire" | "dock" | "guitarist" | "singers" | "laundry" | "tavern" | "flag" | "banner" | "barrels" | "boozer" | "hut";
export interface Prop {
  kind: PropKind;
  /** Where its feet are (sprites) or its middle (painted parts), in scene units. */
  x: number;
  y: number;
  /** Drawn this tall (scene units). 0 = part of the painting, nothing drawn. */
  size: number;
  /** How close a ball must land. */
  r: number;
}
export const PROPS: Prop[] = [
  // sprites
  { kind: "palm", x: 1545, y: 960, size: 330, r: 105 },
  { kind: "toucan", x: 1590, y: 690, size: 70, r: 75 },
  { kind: "dancer", x: 1325, y: 705, size: 120, r: 75 },
  { kind: "drunk", x: 1480, y: 790, size: 85, r: 82 },
  { kind: "chest", x: 1700, y: 1040, size: 120, r: 105 },
  { kind: "rum", x: 1385, y: 1050, size: 120, r: 98 },
  { kind: "kraken", x: 700, y: 950, size: 170, r: 128 },
  { kind: "crab", x: 1465, y: 990, size: 50, r: 68 },
  { kind: "parrot", x: 1235, y: 640, size: 80, r: 68 },
  { kind: "monkey", x: 1300, y: 250, size: 110, r: 90 },
  { kind: "mermaid", x: 1300, y: 880, size: 120, r: 90 },
  { kind: "hammock", x: 1610, y: 905, size: 95, r: 90 },
  { kind: "cannon", x: 1455, y: 730, size: 65, r: 75 },
  // these move (see propAt): x/y are the middle of their route
  { kind: "shark", x: 920, y: 860, size: 55, r: 75 },
  { kind: "rowboat", x: 1010, y: 720, size: 75, r: 90 },
  { kind: "bottle", x: 820, y: 1015, size: 45, r: 60 },
  { kind: "turtle", x: 930, y: 800, size: 45, r: 68 },
  // the painting
  { kind: "bonfire", x: 1515, y: 600, size: 0, r: 82 },
  { kind: "dock", x: 1110, y: 620, size: 0, r: 105 },
  { kind: "guitarist", x: 1640, y: 600, size: 0, r: 75 },
  { kind: "singers", x: 1720, y: 625, size: 0, r: 82 },
  { kind: "laundry", x: 1500, y: 372, size: 0, r: 98 },
  { kind: "tavern", x: 1740, y: 330, size: 0, r: 165 },
  { kind: "flag", x: 1718, y: 140, size: 0, r: 60 },
  { kind: "banner", x: 1880, y: 690, size: 0, r: 82 },
  { kind: "barrels", x: 1705, y: 840, size: 0, r: 82 },
  { kind: "boozer", x: 1830, y: 820, size: 0, r: 90 },
  { kind: "hut", x: 1255, y: 460, size: 0, r: 105 },
];

/**
 * Where a prop is at a moment (seconds, server time). Most stand still; the shark, rowboat,
 * seagull, bottle and turtle travel on fixed loops, so every screen agrees where they are.
 */
export function propAt(p: Prop, t: number): { x: number; y: number; facing: 1 | -1 } {
  const loop = (period: number) => ((t % period) + period) % period / period; // 0..1
  switch (p.kind) {
    case "shark": {
      const a = loop(24) * Math.PI * 2;
      return { x: p.x + 260 * Math.cos(a), y: p.y + 80 * Math.sin(a), facing: Math.sin(a) > 0 ? -1 : 1 };
    }
    case "rowboat": {
      const a = loop(46) * Math.PI * 2;
      return { x: p.x + 170 * Math.sin(a), y: p.y, facing: Math.cos(a) >= 0 ? 1 : -1 };
    }
    case "seagull": {
      const k = loop(19);
      return { x: -120 + k * (SCENE.w + 240), y: p.y + 35 * Math.sin(t * 1.4), facing: 1 };
    }
    case "bottle":
      return { x: p.x + 140 * Math.sin(loop(60) * Math.PI * 2), y: p.y + 6 * Math.sin(t * 2.2), facing: 1 };
    case "turtle": {
      const a = loop(52) * Math.PI * 2;
      return { x: p.x + 260 * Math.sin(a), y: p.y + 20 * Math.sin(a * 2), facing: Math.cos(a) >= 0 ? 1 : -1 };
    }
    default:
      return { x: p.x, y: p.y, facing: 1 };
  }
}
export const MOVING = new Set<PropKind>(["shark", "rowboat", "seagull", "bottle", "turtle"]);

/** The part of the cove a phone held upright shows: the wall and the lagoon in front of it. */
export function playerView(c: Cove) {
  return { x: 585, y: 10, w: 960, h: 1010 };
}

/** A phone held sideways: the wall, the lagoon and a little of the town. */
export function playerViewWide(c: Cove) {
  return { x: 560, y: 10, w: 1080, h: 840 };
}

