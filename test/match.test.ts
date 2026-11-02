import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGuess, parsePhrase } from "../src/server/match.ts";
import { ALL_PUZZLES as PUZZLES, type Puzzle } from "../src/server/puzzles.ts";

const P = (id: string) => parsePhrase(PUZZLES.find((p) => p.id === id)!);
const names = (w: ReturnType<typeof P>, guess: string) => matchGuess(w, guess).map((i) => w[i].text);

test("single words, aliases, plurals and case", () => {
  const w = P("sasquatch");
  assert.deepEqual(names(w, "socks"), ["SOCKS"]);
  assert.deepEqual(names(w, "Sock"), ["SOCKS"]);
  assert.deepEqual(names(w, "BIGFOOT"), ["SASQUATCH"]);
  assert.deepEqual(names(w, "big foot"), ["SASQUATCH"]);
  assert.deepEqual(names(w, "bigfoots"), ["SASQUATCH"]);
  assert.deepEqual(names(w, "  the   socks!! "), ["SOCKS"]);
  assert.deepEqual(names(w, "llama"), []);
});

test("runs of consecutive words, and nothing for wrong combinations", () => {
  const w = P("sasquatch");
  assert.deepEqual(names(w, "alpaca socks"), ["ALPACA", "SOCKS"]);
  assert.deepEqual(names(w, "bitcoin magazine"), ["BITCOIN", "MAGAZINE"]);
  assert.deepEqual(names(w, "llama socks"), [], "one wrong word sinks the whole guess");
  assert.deepEqual(names(w, "socks alpaca"), [], "order matters");
  assert.deepEqual(names(w, "orange sasquatch alpaca socks"), [], "can't skip a hidden word");
});

test("the whole phrase, with or without the small words", () => {
  const w = P("nostrich");
  const all = w.filter((x) => !x.given).map((x) => x.text);
  assert.deepEqual(names(w, "a nostrich zapping a seagull who stole a hardware wallet"), all);
  assert.deepEqual(names(w, "nostrich zapping seagull stole hardware wallet"), all);
  assert.deepEqual(names(w, "Ostrich zaps a gull who swiped a hardware wallet"), all);
});

test("whole words only: BACK never matches BACKPACK", () => {
  const p: Puzzle = { id: "t", title: "t", phrase: "ADAM BACK riding a KANGAROO", aka: { KANGAROO: ["roo"] }, clues: [], imagePrompt: "" };
  const w = parsePhrase(p);
  assert.deepEqual(names(w, "backpack"), []);
  assert.deepEqual(names(w, "back"), ["BACK"]);
  assert.deepEqual(names(w, "adam back"), ["ADAM", "BACK"]);
  assert.deepEqual(names(w, "roo"), ["KANGAROO"]);
  assert.deepEqual(names(w, "riding"), [], "given words score nothing");
  assert.deepEqual(names(w, "a"), []);
});

test("spacing and hyphens don't matter; digits work as listed", () => {
  const q = P("queen");
  assert.deepEqual(names(q, "multi-sig"), ["MULTISIG"]);
  assert.deepEqual(names(q, "multi sig transaction"), ["MULTISIG", "TRANSACTION"]);
  assert.deepEqual(names(q, "3 parrots"), ["THREE", "PARROTS"]);
  const o = P("octopus");
  assert.deepEqual(names(o, "laser-eyes"), ["LASER", "EYES"]);
  assert.deepEqual(names(o, "lasereyes"), [], "two words typed as one aren't split (only one word's spelling is joined)");
  assert.deepEqual(names(o, "sea floor"), ["OCEAN", "FLOOR"]);
});

test("a word that appears twice is revealed in both places", () => {
  const p: Puzzle = { id: "t", title: "t", phrase: "PIRATE hands a PIRATE a PARROT", aka: {}, clues: [], imagePrompt: "" };
  const w = parsePhrase(p);
  assert.deepEqual(matchGuess(w, "pirate"), [0, 3]);
});

test("every puzzle in the bank parses and its own phrase solves it", () => {
  for (const p of PUZZLES) {
    const w = parsePhrase(p);
    const hidden = w.map((x, i) => (x.given ? -1 : i)).filter((i) => i >= 0);
    assert.ok(p.height !== undefined || hidden.length >= ({ bitty: 3, lacrypta: 4, brains: 2 } as Record<string, number>)[p.id] || hidden.length >= 5, `${p.id} has enough hidden words`);
    assert.deepEqual(matchGuess(w, p.phrase), hidden, p.id);
    for (const x of w) if (!x.given) assert.match(x.text, /^[A-Z0-9]+$/, `${p.id}: ${x.text} letters/digits only`);
    for (const k of Object.keys(p.aka)) assert.ok(w.some((x) => x.text === k), `${p.id}: aka ${k} is in the phrase`);
    if (p.height === undefined) assert.equal(p.clues.length, 3);
  }
});

test("a number answer: the whole block height, written any common way", () => {
  const w = parsePhrase({ id: "num", title: "t", phrase: "block height @ 123456", aka: { "123456": ["block 123456", "block height 123456", "height 123456", "blockheight 123456"] }, clues: [], imagePrompt: "" });
  assert.deepEqual(w.map((x) => x.given), [true, true, true, false], "block height @ are shown; the number is hidden");
  for (const g of ["123456", "123,456", "123 456", "#123456", "block 123456", "block height 123456", "Block Height @ 123456"]) assert.deepEqual(names(w, g), ["123456"], g);
  for (const g of ["123", "456", "123457", "1234560"]) assert.deepEqual(names(w, g), [], g);
});

test("round 3: the blanks are LA CRYPTA and BITCOIN SCRIPT; the -a is given", () => {
  const w = P("lacrypta");
  assert.deepEqual(w.filter((x) => !x.given).map((x) => x.text), ["LA", "CRYPTA", "BITCOIN", "SCRIPT"]);
  assert.equal(w.at(-1)!.given, true, "-a is already filled in");
  assert.deepEqual(names(w, "la crypta"), ["LA", "CRYPTA"]);
  assert.deepEqual(names(w, "La Crypta."), ["LA", "CRYPTA"]);
  for (const g of ["bitcoin script", "Bitcoin script-a", "bitcoin scripta", "btc script"]) assert.deepEqual(names(w, g), ["BITCOIN", "SCRIPT"], g);
  assert.deepEqual(names(w, "crypto"), [], "close isn't enough");
  assert.deepEqual(names(w, "la crypta they taught me to write bitcoin script-a"), ["LA", "CRYPTA", "BITCOIN", "SCRIPT"], "the whole thing solves it");
});
