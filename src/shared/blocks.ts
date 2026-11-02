// Bitcoin block heights and dates, roughly: anchored on a few well-known blocks and filled in
// between them. Close enough to say "≈ Aug 2012" under a guess, and to estimate the tip if the
// live height can't be fetched. (A block every ~10 minutes: about 144 a day, 52,560 a year.)

export const BLOCKS_PER_YEAR = 52_560;
export const BLOCKS_PER_DAY = 144;

/** [height, when (ms)] */
const ANCHORS: [number, number][] = [
  [0, Date.UTC(2009, 0, 3, 18, 15)],
  [100_000, Date.UTC(2010, 11, 29, 11, 57)],
  [210_000, Date.UTC(2012, 10, 28, 15, 24)],
  [420_000, Date.UTC(2016, 6, 9, 16, 46)],
  [630_000, Date.UTC(2020, 4, 11, 19, 23)],
  [840_000, Date.UTC(2024, 3, 20, 0, 9)],
];
const MS_PER_BLOCK = 600_000;

/** About when a block was mined. */
export function heightToTime(h: number): number {
  for (let i = 1; i < ANCHORS.length; i++) {
    const [h1, t1] = ANCHORS[i];
    if (h <= h1) {
      const [h0, t0] = ANCHORS[i - 1];
      return t0 + ((h - h0) / (h1 - h0)) * (t1 - t0);
    }
  }
  const [hl, tl] = ANCHORS[ANCHORS.length - 1];
  return tl + (h - hl) * MS_PER_BLOCK;
}

/** About which block was being mined at a moment. */
export function timeToHeight(t: number): number {
  for (let i = 1; i < ANCHORS.length; i++) {
    const [h1, t1] = ANCHORS[i];
    if (t <= t1) {
      const [h0, t0] = ANCHORS[i - 1];
      return Math.max(0, Math.round(h0 + ((t - t0) / (t1 - t0)) * (h1 - h0)));
    }
  }
  const [hl, tl] = ANCHORS[ANCHORS.length - 1];
  return Math.round(hl + (t - tl) / MS_PER_BLOCK);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Aug 2012" */
export function monthYear(t: number) {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** "Aug 1, 2012" */
export function dayMonthYear(t: number) {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** How far off a guess was, in plain words: "exact", "3 days", "5 months", "2.4 years". */
export function offText(blocks: number) {
  const b = Math.abs(blocks);
  if (b === 0) return "exact";
  const days = b / BLOCKS_PER_DAY;
  if (days < 1) return `${b.toLocaleString("en-US")} blocks`;
  if (days < 45) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  if (days < 365) return `${Math.round(days / 30.4)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

/**
 * Points for a guess: closeness × speed. Multiplying (not adding) means a wild guess scores
 * only a few points however fast it was, while among sensible guesses a quick one beats a
 * slow, fine-tuned one (waiting out the clock to get precise doesn't pay).
 *
 * Closeness falls off on a log scale, 1 / (1 + ln(1 + days off / scaleDays))^1.5:
 *   exact 1 · 1 week .76 · 1 month .45 · 3 months .27 · 1 year .15 · 3 years .10 · 10 years .07
 * Speed: 1 if you lock in at once, falling to 0.25 at the buzzer.
 * Anyone who locks in gets at least 1 point.
 */
export function guessPoints(guess: number, answer: number, timeLeftShare: number, max = 100, scaleDays = 30) {
  const days = Math.abs(guess - answer) / BLOCKS_PER_DAY;
  const close = (1 / (1 + Math.log(1 + days / scaleDays))) ** 1.5;
  const speed = 0.25 + 0.75 * Math.max(0, Math.min(1, timeLeftShare));
  return Math.max(1, Math.round(max * close * speed));
}
