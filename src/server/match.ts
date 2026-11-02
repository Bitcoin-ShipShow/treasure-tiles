// Deciding whether a typed guess is right. No AI: words are compared after light cleanup.
//
// A guess is right when it spells one or more consecutive words of the phrase, using the
// official words or their listed alternatives ("bigfoot" for SASQUATCH). So "socks",
// "alpaca socks" and the whole phrase all work; "llama socks" does not. Small words like
// "a" and "the" may be left out or added. Plurals match singulars ("sock" = SOCKS), and
// spacing/hyphens don't matter ("multi-sig" = MULTISIG). Words are compared whole, so BACK
// never matches inside BACKPACK.

import type { Puzzle } from "./puzzles.ts";

export interface Word {
  text: string; // official spelling, upper case
  given: boolean;
  /** Each accepted spelling as lower-case tokens. */
  alts: string[][];
}

const SMALL = new Set(["a", "an", "the", "of", "with", "his", "her", "its", "their", "on", "onto", "in", "into", "at", "to", "for", "and", "who", "that", "is", "full"]);

export function tokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function forms(t: string): string[] {
  const out = [t];
  if (t.length > 3 && t.endsWith("s")) out.push(t.slice(0, -1));
  if (t.length > 4 && t.endsWith("es")) out.push(t.slice(0, -2));
  return out;
}
export function same(a: string, b: string): boolean {
  if (a === b) return true;
  const fb = forms(b);
  return forms(a).some((x) => fb.includes(x));
}

export function parsePhrase(p: Puzzle): Word[] {
  return p.phrase.split(/\s+/).map((raw) => {
    // Hidden: capital letters and/or digits (a number like 123456 is a hidden word too).
    // Given: anything with lowercase letters, or no letters or digits at all (like "@").
    const given = raw !== raw.toUpperCase() || !/[A-Z0-9]/.test(raw);
    const text = raw.toUpperCase();
    const alts = given ? [tokens(raw)] : [text, ...(p.aka[text] ?? [])].map(tokens).filter((a) => a.length);
    return { text, given, alts };
  });
}

/** Indexes of the hidden words this guess names, or [] for a miss. */
export function matchGuess(words: Word[], guess: string): number[] {
  const g = tokens(guess).slice(0, 30);
  if (!g.length) return [];
  const hits = new Set<number>();
  // memo key: guess position, phrase position -> phrase positions where a run can end
  const memo = new Map<string, number[]>();
  const ends = (gi: number, j: number): number[] => {
    const key = `${gi},${j}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const out = new Set<number>();
    if (gi === g.length) out.add(j);
    if (gi < g.length && SMALL.has(g[gi])) for (const e of ends(gi + 1, j)) out.add(e);
    if (j < words.length) {
      const w = words[j];
      if (w.given) {
        if (gi < g.length && w.alts[0].length === 1 && same(g[gi], w.alts[0][0])) for (const e of ends(gi + 1, j + 1)) out.add(e);
        for (const e of ends(gi, j + 1)) out.add(e); // a given word may be left out
      } else {
        for (const n of consume(g, gi, w.alts)) for (const e of ends(gi + n, j + 1)) out.add(e);
      }
    }
    const res = [...out];
    memo.set(key, res);
    return res;
  };
  // A run may start on any word (so typing the whole verse works); only hidden words score.
  for (let start = 0; start < words.length; start++) {
    for (const end of ends(skipSmall(g, 0), start)) {
      for (let k = start; k < end; k++) if (!words[k].given) hits.add(k);
    }
  }
  return [...hits].sort((a, b) => a - b);
}

function skipSmall(g: string[], i: number) {
  while (i < g.length && SMALL.has(g[i])) i++;
  return i;
}

/** How many guess tokens starting at gi spell one of these alternatives (several answers possible). */
function consume(g: string[], gi: number, alts: string[][]): number[] {
  const out = new Set<number>();
  for (const alt of alts) {
    // token by token: "big foot" = "big foot"
    if (gi + alt.length <= g.length && alt.every((t, i) => same(g[gi + i], t))) out.add(alt.length);
    // ignoring spaces: "multi sig" = "multisig", "lasereyes"... up to 3 typed tokens
    const joined = alt.join("");
    let acc = "";
    for (let n = 1; n <= 3 && gi + n <= g.length; n++) {
      acc += g[gi + n - 1];
      if (same(acc, joined)) out.add(n);
    }
  }
  return [...out];
}
