import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game, sha256 } from "../src/server/game.ts";
import { ALL_PUZZLES as BANK, heightRound } from "../src/server/puzzles.ts";

// A made-up show (the real rounds are private): three rounds, then the final.
const PUZZLES = [
  heightRound("r1", "Round One", 600000, "2019-10-21T00:00:00Z", "When round one happened"),
  heightRound("r2", "Round Two", 300000, "2014-05-12T00:00:00Z", "When round two happened"),
  heightRound("r3", "Round Three", 750000, "2022-08-12T00:00:00Z", "When round three happened"),
  { ...heightRound("fin", "The Final", 150000, "2011-10-20T00:00:00Z", "When the final happened"), finalOnly: true },
];
import { cove, landing, playerView, shipAt } from "../src/shared/cannon.ts";
import { guessPoints, heightToTime, offText, timeToHeight } from "../src/shared/blocks.ts";

const PZ = ["saylor", "sasquatch"].map((id) => BANK.find((p) => p.id === id)!);

async function setup(n = 4) {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-"));
  let t = 5_000_000;
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const make = () => new Game({ dataDir, imagesDir: join(dataDir, "none"), now: () => t, random, puzzles: PZ });
  const g = make();
  await g.init();
  await g.setSettings({ countdownSeconds: 0, tileEverySeconds: 0, letterEverySeconds: 0, clueEverySeconds: 0, tilesPerPlayer: 0, preFallen: 0, krakenRounds: 2, hitPoints: 1, gameSeconds: 75 });
  const pks = Array.from({ length: n }, (_, i) => {
    const pk = (i + 1).toString(16).padStart(64, "a");
    g.join(pk, `P${i}`);
    return pk;
  });
  const advance = (ms: number) => {
    t += ms;
    g.tick();
  };
  return { g, pks, advance, make, now: () => t };
}

/** An aim from this player's ship (right now) that lands well inside a still-covered tile. */
function aimAtCovered(g: Game, pk: string) {
  const c = g.cove;
  const ship = shipAt(g.s.players[pk].slot, g.now() / 1000, c);
  const k = g.s.image.w / c.pic.w;
  for (let p = 0.05; p <= 1; p += 0.01)
    for (let a = -45; a <= 45; a += 2) {
      const l = landing(ship, a, p, g.s.wind, c);
      if (l.result !== "wall") continue;
      const x = (l.x - c.pic.x) * k;
      const y = (l.y - c.pic.y) * k;
      const i = g.s.tiles.findIndex((t) => {
        const xs = t.points.map((q) => q[0]);
        const ys = t.points.map((q) => q[1]);
        return Math.min(...xs) + 70 < x && x < Math.max(...xs) - 70 && Math.min(...ys) + 70 < y && y < Math.max(...ys) - 70;
      });
      if (i >= 0 && g.s.fallen[i] === false && !g.s.cracking[i]) return { a, p, i };
    }
  throw new Error("no aim found");
}

test("the opening hook starts uncovered; the punchline doesn't", async () => {
  const { g } = await setup();
  const st = g.publicState();
  const [l, top, r, b] = g.puzzleInfo.start!;
  st.tiles.forEach((t, i) => {
    const pts = g.s.tiles[i].points;
    const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length / g.s.image.w;
    const cy = pts.reduce((a, q) => a + q[1], 0) / pts.length / g.s.image.h;
    assert.equal(!!t.img, cx >= l && cx <= r && cy >= top && cy <= b, `tile ${i}`);
  });
  assert.ok(st.tiles.some((t) => t.img) && st.tiles.some((t) => !t.img));
});

test("the letters of SHIPSHOW are filled in from the start, never a whole word; a host can turn that off", async () => {
  const { g } = await setup();
  const st = g.publicState();
  // MICHAEL SAYLOR SCREAMING because a BEAR is BITING his FOOT
  const shown = st.words.map((w) => (w.given ? w.text : Array.from({ length: w.len }, (_, k) => w.letters[k] ?? "_").join("")));
  assert.deepEqual(shown, ["_I_H___", "S___O_", "S_____I__", "BECAUSE", "A", "____", "IS", "_I_I__", "HIS", "_OO_"]);
  // FOOT: O and O shown, F and T still blank; nothing fully given away
  for (const w of st.words) if (!w.given) assert.ok(Object.keys(w.letters).length < w.len);
  await g.setSettings({ freeLetters: "" });
  for (const w of g.publicState().words) if (!w.given) assert.deepEqual(w.letters, {}, "none given");
});

test("more letters appear over time, but each word keeps at least one blank", async () => {
  const { g, advance } = await setup();
  await g.setSettings({ letterEverySeconds: 5, gameSeconds: 1200 });
  g.start();
  const count = () => g.publicState().words.reduce((n, w) => n + Object.keys(w.letters).length, 0);
  const before = count();
  advance(5_050);
  assert.equal(count(), before + 1);
  for (let i = 0; i < 100; i++) advance(5_050);
  for (const w of g.publicState().words) if (!w.given) assert.equal(Object.keys(w.letters).length, w.len - 1, "one blank left");
});

test("ships sail the lagoon in front of the cliff, and every page computes the same course", () => {
  const c = cove(1312, 1199);
  const a = shipAt(3, 100, c);
  const b = shipAt(3, 110, c);
  assert.notEqual(a.x, b.x, "it moves");
  assert.deepEqual(shipAt(3, 100, c), a, "same answer every time");
  for (let slot = 0; slot < 30; slot++)
    for (let t = 0; t < 300; t += 7) {
      const s = shipAt(slot, t, c);
      assert.ok(s.x > 600 && s.x < 1280 && s.y > c.water && s.y < c.h, `slot ${slot} stays in the lagoon (and in every phone's view)`);
    }
});

test("the picture is fitted onto the cliff panel", () => {
  const tall = cove(1312, 1199);
  const wide = cove(1600, 1200);
  for (const c of [tall, wide]) {
    assert.ok(c.pic.y >= 30 && c.pic.y + c.pic.h <= c.water, "above the foot of the cliff");
    assert.ok(c.pic.x >= 560 && c.pic.x + c.pic.w <= 1250, "big, between the scoreboard and the town");
    assert.ok(c.pic.w >= 560 || c.pic.h >= 560, "and big");
  }
  assert.ok(Math.abs(tall.pic.w / tall.pic.h - 1312 / 1199) < 0.01, "keeps its shape");
});

test("cannon physics: short, cliff, over, wide, rock, the town, angle and wind", () => {
  const c = cove(1600, 1200);
  const from = { x: 905, y: 900 };
  const at = (a: number, p: number, w = 0) => landing(from, a, p, w, c);
  assert.equal(at(0, 0.05).result, "short");
  assert.ok(at(0, 0.05).y > c.water, "short shots land in the lagoon");
  assert.equal(at(0, 1).result, "over");
  const low = at(0, 0.25);
  const high = at(0, 0.5);
  assert.equal(low.result, "wall");
  assert.equal(high.result, "wall");
  assert.ok(low.y > high.y, "more power lands higher up");
  assert.equal(at(0, 0.77).result, "rock", "just above the picture is bare rock");
  assert.ok(at(20, 0.3).x > at(-20, 0.3).x, "angle steers");
  assert.ok(at(0, 0.3, 0.8).x > at(0, 0.3, -0.8).x, "wind pushes");
  assert.equal(at(60, 0.5).result, "town", "far right hits the pirate town");
  assert.equal(landing({ x: 30, y: 900 }, -80, 0.9, 0, c).result, "wide");
  // sideways and gentle: it lands on the beach where the props are
  const beach = at(75, 0.3);
  assert.equal(beach.result, "short");
  assert.ok(beach.x > 1150, "a sideways shot can reach the beach");
});

test("a hit: only the shooter gets a link for a few seconds, then the slab falls for everyone", async () => {
  const { g, pks, advance } = await setup();
  g.start();
  const { a, p, i } = aimAtCovered(g, pks[0]);
  const r = g.fire(pks[0], a, p);
  assert.match(r.message, /^peek: /);
  const peek = JSON.parse(r.message.slice(6));
  assert.equal(peek.tile, i);
  const token = peek.url.split("/").pop();
  assert.ok(g.tileFile(g.s.gameId, token), "the shooter's private link works");
  const st = g.publicState();
  assert.ok(!st.tiles[i].img);
  assert.equal(st.cracking[i].pk, pks[0]);
  assert.ok(!JSON.stringify(st).includes(token.slice(0, 32)), "the private link isn't public");
  assert.equal(g.tileFile(g.s.gameId, `${g.s.tiles[i].token}.webp`), null);
  assert.equal(st.shots.at(-1)!.result, "hit");
  advance(g.settings.peekSeconds * 1000 + 50);
  assert.ok(g.publicState().tiles[i].img);
  assert.equal(g.s.players[pks[0]].hits, 1);
  assert.equal(g.s.players[pks[0]].points, g.settings.hitPoints, "a hit scores");
});

test("reload: one shot per reload time; weak shots splash", async () => {
  const { g, pks, advance } = await setup();
  g.start();
  assert.equal(g.fire(pks[1], 0, 0.02).message, "short");
  assert.throws(() => g.fire(pks[1], 0, 0.02), /Reloading/);
  advance(1000);
  assert.equal(g.fire(pks[1], 0, 0.02).message, "short");
  assert.equal(g.publicState().shots.length, 2);
});

test("wrong guesses lock you out briefly; right ones don't; first to the server wins the word", async () => {
  const { g, pks, advance } = await setup();
  g.start();
  assert.equal(g.guess(pks[0], "shark").message, "miss");
  assert.throws(() => g.guess(pks[0], "bear"), /wait 4s/);
  assert.match(g.guess(pks[1], "bear").message, /^hit: BEAR \+4/);
  assert.match(g.guess(pks[2], "grizzly").message, /^duplicate/);
  assert.match(g.guess(pks[2], "foot").message, /^hit/);
  assert.match(g.guess(pks[2], "biting").message, /^hit/, "no lockout after right answers");
  advance(4100);
  assert.match(g.guess(pks[0], "michael saylor").message, /^hit/);
  const st = g.publicState();
  assert.equal(st.misses, 1);
  assert.deepEqual(st.topMiss, { text: "SHARK", n: 1 });
});

test("solving ends the game; the treasure is split by points; the sealed answer checks out", async () => {
  const { g, pks } = await setup();
  g.start();
  g.guess(pks[0], "bear"); // 4
  g.guess(pks[1], "foot"); // 4
  assert.match(g.guess(pks[2], "michael saylor screaming because a bear is biting his foot").message, /^solved/);
  assert.equal(g.phase, "final");
  const f = g.s.final!;
  assert.equal(f.solvedBy, pks[2]);
  assert.deepEqual(f.ranking.map((x) => x.points), [38, 4, 4]); // 7+6+9+6 + 10 bonus
  assert.equal(f.stage, "prelim");
  assert.deepEqual(f.ranking.map((x) => x.share), [0, 0, 0], "prelim rounds pay nothing");
  assert.deepEqual(g.s.show.totals, { [pks[2]]: 38, [pks[0]]: 4, [pks[1]]: 4 }, "they add to the show totals");
  assert.equal(sha256(`${f.salt}|${f.answer}`), g.s.commitment);
});

test("the final: time runs out, winner-takes-all option; nobody scoring pays nobody", async () => {
  const { g, pks, advance } = await setup();
  await g.setSettings({ prizeSplit: "winner" });
  await g.startFinal("saylor");
  g.start();
  g.guess(pks[0], "bear");
  advance(g.settings.finalSeconds * 1000 + 10);
  assert.equal(g.s.final!.reason, "time");
  assert.deepEqual(g.s.final!.ranking, [{ pk: pks[0], points: 4, share: 10000 }]);
  const t2 = await setup();
  await t2.g.startFinal("saylor");
  t2.g.start();
  t2.advance(t2.g.settings.finalSeconds * 1000 + 10);
  assert.deepEqual(t2.g.s.final!.ranking, []);
});

test("timers for slabs and clues; pause freezes everything", async () => {
  const { g, advance } = await setup();
  await g.setSettings({ tileEverySeconds: 10, clueEverySeconds: 30 });
  g.start();
  const up = () => g.s.fallen.filter((f) => f === false).length;
  const before = up();
  advance(10_050);
  assert.equal(up(), before - 1);
  g.pause();
  advance(60_000);
  assert.equal(up(), before - 1, "nothing falls while paused");
  g.resume();
  advance(20_050);
  assert.equal(g.publicState().clues.length, 1);
  assert.equal(g.publicState().feed.at(-1)!.kind, "clue");
});

test("the public state never contains the answer, the clues, or slabs that haven't fallen", async () => {
  const { g, pks } = await setup();
  g.start();
  g.guess(pks[0], "bear");
  const { settings: _s, ...rest } = g.publicState();
  const json = JSON.stringify(rest).toUpperCase();
  for (const w of ["MICHAEL", "SAYLOR", "SCREAMING", "BITING", "FOOT", "GRIZZLY"]) assert.ok(!json.includes(w), `${w} leaked`);
  assert.ok(json.includes("BEAR"), "found words are shown");
  for (const clue of PZ[0].clues) assert.ok(!json.includes(clue.toUpperCase()));
  assert.ok(!json.includes(g.s.fullToken.toUpperCase()));
  g.s.tiles.forEach((t, i) => assert.equal(json.includes(t.token.toUpperCase()), g.s.fallen[i] !== false, `tile ${i}`));
  const up = g.s.tiles.findIndex((_, i) => g.s.fallen[i] === false);
  assert.equal(g.tileFile(g.s.gameId, `${g.s.tiles[up].token}.webp`), null);
  assert.equal(g.tileFile(g.s.gameId, `${g.s.fullToken}.jpg`), null);
});

test("a restart picks up exactly where the game was", async () => {
  const { g, pks, make } = await setup();
  g.start();
  g.guess(pks[1], "bear");
  g.guess(pks[0], "rum");
  const before = g.publicState();
  const g2 = make();
  await g2.init();
  assert.deepEqual({ ...g2.publicState(), v: 0 }, { ...before, v: 0 });
  assert.throws(() => g2.guess(pks[0], "foot"), /wait/, "a lockout survives the restart");
});

test("a new game keeps the players but resets scores, slabs and letters", async () => {
  const { g, pks } = await setup();
  g.start();
  g.guess(pks[0], "bear");
  await g.newGame("sasquatch");
  assert.equal(g.phase, "lobby");
  assert.equal(Object.keys(g.s.players).length, 4);
  assert.ok(Object.values(g.s.players).every((p) => p.points === 0 && p.shots === 0));
  assert.equal(g.puzzleInfo.id, "sasquatch");
  assert.ok(g.s.fallen.every((f) => f === false || f === null));
});

test("the show: prelim rounds add up, then the top 3 play the final for the treasure", async () => {
  const { g, pks, advance } = await setup(5);
  // round 1 (saylor): P0 and P1 score
  g.start();
  g.guess(pks[0], "michael saylor"); // 13
  g.guess(pks[1], "bear"); // 4
  advance(g.settings.gameSeconds * 1000 + 10);
  assert.equal(g.s.final!.stage, "prelim");
  // round 2 picks the next puzzle not played yet
  await g.nextRound();
  assert.equal(g.puzzleInfo.id, "sasquatch");
  assert.equal(g.s.show.round, 2);
  g.start();
  g.guess(pks[2], "magazine"); // 8
  g.guess(pks[3], "socks"); // 5
  g.guess(pks[1], "orange"); // 6 -> P1 total 10
  advance(g.settings.gameSeconds * 1000 + 10);
  assert.deepEqual(g.s.show.totals, { [pks[0]]: 13, [pks[1]]: 10, [pks[2]]: 8, [pks[3]]: 5 });
  // the final: top 3 only
  await g.startFinal("saylor");
  assert.deepEqual(g.s.show.finalists, [pks[0], pks[1], pks[2]]);
  g.start();
  assert.throws(() => g.guess(pks[3], "bear"), /Only the three finalists/);
  assert.throws(() => g.fire(pks[4], 0, 0.5), /Only the three finalists/);
  g.guess(pks[2], "bear"); // 4
  g.guess(pks[0], "foot"); // 4
  advance(g.settings.finalSeconds * 1000 + 10);
  const f = g.s.final!;
  assert.equal(f.stage, "final");
  assert.deepEqual(f.ranking.map((r) => [r.pk, r.share]).sort(), [[pks[0], 5000], [pks[2], 5000]].sort(), "the treasure is split by final points");
  // a new show starts over
  await g.newShow();
  assert.deepEqual(g.s.show, { stage: "prelim", round: 1, totals: {}, finalists: [], played: ["saylor"], eliminated: [] });
});

test("practice shots between rounds: they fly and count for nothing", async () => {
  const { g, pks, advance } = await setup();
  const before = JSON.stringify(g.s.fallen);
  // in the lobby, aimed right at the picture
  const c = g.cove;
  const r = g.fire(pks[0], 0, 0.3);
  assert.match(r.message, /^practice: /);
  assert.equal(JSON.stringify(g.s.fallen), before, "no slab falls");
  assert.deepEqual(Object.keys(g.s.cracking), []);
  assert.equal(g.s.players[pks[0]].shots, 0, "not counted");
  assert.equal(g.s.players[pks[0]].points, 0);
  const shot = g.publicState().shots.at(-1)!;
  assert.equal(shot.practice, true);
  assert.notEqual(shot.result, "hit");
  assert.throws(() => g.fire(pks[0], 0, 0.3), /Reloading/, "still has to reload");
  // after a round ends, practice again (even someone who isn't a finalist)
  g.start();
  advance(g.settings.gameSeconds * 1000 + 10);
  advance(1000);
  assert.match(g.fire(pks[1], 10, 0.2).message, /^practice: /);
  void c;
});

test("the kraken: 15 seconds into rounds 1 and 2, half the bottom third are dragged under", async () => {
  const { g, pks, advance } = await setup(9);
  g.start();
  // the top six have points from earlier; the bottom three have nothing
  pks.slice(0, 6).forEach((pk, i) => (g.s.show.totals[pk] = 10 + i));
  advance(14_000);
  assert.equal(g.phase, "open");
  advance(1_100);
  assert.equal(g.phase, "kraken");
  const k = g.publicState().kraken!;
  assert.deepEqual([...k.candidates].sort(), [pks[6], pks[7], pks[8]].sort(), "the bottom third (three of nine)");
  assert.equal(k.doomed.length, 2, "half of them, rounded up");
  assert.ok(k.doomed.every((pk) => k.candidates.includes(pk)));
  // nobody can act while it happens, and the round clock stands still
  assert.throws(() => g.guess(pks[0], "his"), /kraken/);
  assert.throws(() => g.fire(pks[0], 0, 0.5), /kraken/);
  const deadline = g.s.deadline;
  advance(11_100);
  assert.equal(g.phase, "open");
  assert.ok(g.s.deadline >= deadline + 11_000, "the round got the time back");
  assert.deepEqual([...g.s.show.eliminated].sort(), [...k.doomed].sort());
  assert.throws(() => g.guess(k.doomed[0], "rum"), /dragged you under/);
  assert.throws(() => g.fire(k.doomed[0], 0, 0.5), /dragged you under/);
  // only once per round
  advance(10_000);
  assert.equal(g.phase, "open");
  // round 2: it happens again; round 3: it doesn't
  advance(g.settings.gameSeconds * 1000);
  await g.nextRound();
  g.start();
  advance(15_100);
  assert.equal(g.phase, "kraken");
  advance(11_100);
  assert.equal(g.s.show.eliminated.length, 3, "one more of the remaining bottom third");
  advance(g.settings.gameSeconds * 1000);
  await g.nextRound("saylor");
  g.start();
  advance(15_100);
  assert.equal(g.phase, "open", "no kraken in round 3");
  // the dragged-under can't reach the final
  advance(g.settings.gameSeconds * 1000);
  await g.startFinal("saylor");
  for (const pk of g.s.show.eliminated) assert.ok(!g.s.show.finalists.includes(pk));
});

test("the kraken stays asleep with too few players, and always leaves three for the final", async () => {
  const { g, advance } = await setup(5);
  g.start();
  advance(15_100);
  assert.equal(g.phase, "open", "fewer than seven players: no kraken");
  const t2 = await setup(7);
  await t2.g.setSettings({ krakenMinPlayers: 4 });
  t2.g.start();
  t2.advance(15_100);
  assert.equal(t2.g.phase, "kraken");
  t2.advance(11_100);
  assert.ok(Object.keys(t2.g.s.players).length - t2.g.s.show.eliminated.length >= 3);
});



test("round 2 (Bitty): at 20 s the kraken takes the bottom sixth outright, no lottery", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-bitty-"));
  let t = 11_000_000;
  const g = new Game({ dataDir, imagesDir: join(dataDir, "none"), now: () => t, puzzles: BANK });
  await g.init();
  await g.setSettings({ krakenRounds: 2, tilesPerPlayer: 0, countdownSeconds: 0 });
  const pks = Array.from({ length: 12 }, (_, i) => (i + 1).toString(16).padStart(64, "d"));
  pks.forEach((pk, i) => g.join(pk, `B${i}`));
  // jump to round 2
  await g.nextRound("bitty");
  assert.equal(g.s.show.round, 2);
  // everyone but the last two has points from round 1
  pks.slice(0, 10).forEach((pk, i) => (g.s.show.totals[pk] = 5 + i));
  g.start();
  const step = (secs: number) => {
    for (let i = 0; i < secs * 10; i++) {
      t += 100;
      g.tick();
    }
  };
  step(19.5);
  assert.equal(g.phase, "open", "not before 20 s");
  step(0.7);
  assert.equal(g.phase, "kraken");
  const k = g.publicState().kraken!;
  assert.equal(k.lottery, false);
  assert.deepEqual([...k.doomed].sort(), [pks[10], pks[11]].sort(), "the bottom sixth (2 of 12): the two with no points");
  assert.deepEqual(k.candidates, k.doomed);
  step(7.2);
  assert.equal(g.phase, "open");
  assert.deepEqual([...g.s.show.eliminated].sort(), [pks[10], pks[11]].sort());
  // only the outer edge started uncovered: mostly covered
  const open = g.s.fallen.filter((f) => f === null).length;
  assert.ok(open > 0 && open / g.s.tiles.length < 0.45, `${open} of ${g.s.tiles.length} slabs open at the start`);
  g.s.tiles.forEach((tile, i) => {
    if (g.s.fallen[i] !== null) return;
    const cx = tile.points.reduce((a, q) => a + q[0], 0) / tile.points.length / g.s.image.w;
    const cy = tile.points.reduce((a, q) => a + q[1], 0) / tile.points.length / g.s.image.h;
    assert.ok(cx < 0.1 || cx > 0.9 || cy < 0.12 || cy > 0.88, "open slabs are on the edge");
  });
  // and the phrase: Bitty makes coffee at Antidote ("Bittie" counts too)
  assert.match(g.guess(pks[0], "bittie").message, /^hit: BITTY/);
  assert.match(g.guess(pks[0], "makes coffee at antidote").message, /^solved/);
});

test("pirates: the final only, one each, at the nearest rival ship; they change no scores", async () => {
  const { g, pks, advance } = await setup(5);
  g.start();
  assert.throws(() => g.launchPirate(pks[0]), /only for the final/);
  g.guess(pks[0], "michael saylor");
  g.guess(pks[1], "bear");
  g.guess(pks[2], "foot");
  advance(g.settings.gameSeconds * 1000 + 10);
  await g.startFinal("sasquatch");
  assert.throws(() => g.launchPirate(pks[0]), /Wait for the final to start/);
  g.start();
  assert.throws(() => g.launchPirate(pks[3]), /Only the three finalists/);
  const c = g.cove;
  const t = g.now() / 1000;
  const at = (pk: string) => shipAt(g.s.players[pk].slot, t, c);
  const d = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
  const nearest = d(pks[0], pks[1]) <= d(pks[0], pks[2]) ? pks[1] : pks[2];
  const shot = JSON.parse(g.launchPirate(pks[0]).message.slice(7));
  assert.equal(shot.to, nearest, "it flies at the nearest rival ship");
  assert.equal(shot.left, 0);
  assert.throws(() => g.launchPirate(pks[0]), /out of pirates/);
  assert.equal(g.s.players[pks[0]].points, 0, "throwing pirates scores nothing");
  advance(g.settings.finalSeconds * 1000 + 10);
  await g.newShow();
  assert.deepEqual(g.publicState().pirates, [], "a new show starts with full pockets");
});

test("the glorious reveal: the titled picture is only served once someone solves it", async () => {
  const { g, pks } = await setup();
  const sharp = (await import("sharp")).default;
  const { mkdirSync } = await import("node:fs");
  const imagesDir = (g as unknown as { opts: { imagesDir: string } }).opts.imagesDir;
  mkdirSync(imagesDir, { recursive: true });
  await sharp({ create: { width: 40, height: 30, channels: 3, background: "#f00" } }).png().toFile(join(imagesDir, "sasquatch-reveal.png"));
  await g.nextRound("sasquatch");
  const token = g.s.revealToken!;
  assert.ok(token, "the reveal is prepared with the round");
  assert.equal(g.tileFile(g.s.gameId, `${token}.jpg`), null, "hidden while playing");
  g.start();
  assert.equal(g.tileFile(g.s.gameId, `${token}.jpg`), null);
  g.end();
  assert.equal(g.s.final!.revealUrl, undefined, "ended without a solve: no reveal");
  assert.equal(g.tileFile(g.s.gameId, `${token}.jpg`), null);
  await g.nextRound("sasquatch");
  g.start();
  for (const w of g.hiddenWords) g.guess(pks[0], w.text);
  assert.equal(g.s.final!.reason, "solved");
  assert.equal(g.s.final!.revealUrl, `/tile/${g.s.gameId}/${g.s.revealToken}.jpg`);
  assert.ok(g.tileFile(g.s.gameId, `${g.s.revealToken}.jpg`));
});

test("the cannon fires any way round: backwards lands in the lagoon in front, never on the cliff", async () => {
  const { g } = await setup();
  const c = g.cove;
  const ship = { x: 900, y: 750 };
  for (const a of [120, 180, -180, -120, 95, -95]) {
    for (const p of [0.1, 0.3, 0.6, 1]) {
      const l = landing(ship, a, p, 0, c);
      assert.ok(["short", "wide"].includes(l.result), `${a}° ${p}: ${l.result}`);
      if (Math.abs(a) > 90) assert.ok(l.y > ship.y, "it goes back toward the viewer");
    }
  }
  assert.equal(landing(ship, 180, 1, 0, c).result, "wide", "full power backwards flies out of the picture");
  assert.equal(landing(ship, 180, 0.05, 0, c).result, "short", "a gentle lob splashes behind the ship");
  assert.equal(landing(ship, 0, 0.5, 0, c).result === "short" || landing(ship, 0, 0.5, 0, c).y < c.water, true);
  // the server takes any angle
  assert.match(g.fire(Object.keys(g.s.players)[0], 170, 0.2).message, /^practice: /);
});


test("prize claim: only the final's winners, a valid Lightning address, and it never goes public", async () => {
  const { g, pks, advance } = await setup(5);
  g.start();
  g.guess(pks[0], "michael saylor");
  g.guess(pks[1], "bear");
  g.guess(pks[2], "foot");
  advance(g.settings.gameSeconds * 1000 + 10);
  assert.throws(() => g.claimPrize(pks[0], "a@b.com"), /when the final is over/, "not after a prelim round");
  await g.startFinal("sasquatch");
  g.start();
  g.guess(pks[0], "socks");
  assert.throws(() => g.claimPrize(pks[0], "a@b.com"), /when the final is over/, "not while it's running");
  advance(g.settings.finalSeconds * 1000 + 10);
  assert.throws(() => g.claimPrize(pks[1], "a@b.com"), /Only the final's winners/, "no share, no claim");
  assert.throws(() => g.claimPrize(pks[0], "not an address"), /Lightning address/);
  assert.match(g.claimPrize(pks[0], "  Captain@WalletOfSatoshi.com ").message, /^prize: /);
  assert.deepEqual(g.publicState().claimed, [pks[0]]);
  assert.ok(!JSON.stringify(g.publicState()).includes("walletofsatoshi"), "the address isn't public");
  assert.deepEqual(g.secrets().payouts, [{ pk: pks[0], name: "P0", sats: 10000, address: "captain@walletofsatoshi.com", status: "waiting", error: null }]);
});

// ───────────── the block-height game ─────────────

test("block heights and dates: anchors, and the date a height means", () => {
  assert.equal(timeToHeight(Date.UTC(2024, 3, 20, 0, 9)), 840000);
  const h3 = heightToTime(630000);
  assert.ok(Math.abs(h3 - Date.UTC(2020, 4, 11, 19, 23)) < 86_400_000, "630,000 is the third halving, May 2020");
  const h2 = timeToHeight(Date.parse("2016-07-09T16:46:00Z"));
  assert.equal(h2, 420000, "the second halving");
  assert.equal(offText(0), "exact");
  assert.equal(offText(144 * 3), "3 days");
  assert.equal(offText(52_560 * 2), "2.0 years");
});

test("scoring: closeness × speed; a wild guess gets only a few points, a quick sensible one beats a slow exact one", () => {
  assert.equal(guessPoints(500_000, 500_000, 1), 100, "exact, at once");
  assert.equal(guessPoints(500_000, 500_000, 0), 25, "exact, at the buzzer");
  const now = (days: number) => guessPoints(500_000 + Math.round(days * 144), 500_000, 1);
  assert.ok(now(7) > now(30) && now(30) > now(365) && now(365) > now(3650), "closer = more");
  assert.ok(now(3650) <= 10 && now(3650) >= 1, `a wild instant guess gets only a few points (${now(3650)})`);
  const quickClose = guessPoints(500_000 + 30 * 144, 500_000, 0.9); // a month off, early
  const slowExact = guessPoints(500_000, 500_000, 0.1); // exact, late
  assert.ok(quickClose > slowExact, `quick and close (${quickClose}) beats slow and exact (${slowExact})`);
});

async function heightShow(n = 4) {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-height-"));
  let t = 20_000_000;
  const g = new Game({ dataDir, imagesDir: join(dataDir, "none"), now: () => t, puzzles: PUZZLES });
  await g.init();
  await g.setSettings({ tilesPerPlayer: 0, countdownSeconds: 0 });
  const pks = Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(64, "d"));
  pks.forEach((pk, i) => g.join(pk, `H${i}`));
  return { g, pks, advance: (ms: number) => ((t += ms), g.tick()) };
}

test("the show: three block-height rounds, then the final", async () => {
  assert.deepEqual(PUZZLES.map((p) => [p.id, p.height, !!p.finalOnly]), [["r1", 600000, false], ["r2", 300000, false], ["r3", 750000, false], ["fin", 150000, true]]);
  const { g } = await heightShow();
  const st = g.publicState();
  assert.equal(st.mode, "height");
  assert.equal(st.show.prelimTotal, 3);
  assert.ok(st.tipHeight > 900_000);
  assert.ok(!JSON.stringify(st).includes("600000"), "the answer isn't public");
  assert.throws(() => g.guess(Object.keys(g.s.players)[0], "600000"), /dial/, "no typed guesses");
});

test("locking in: one guess each, secret till the end, scored by closeness and speed; everyone in ends the round", async () => {
  const { g, pks, advance } = await heightShow(3);
  assert.throws(() => g.lockHeight(pks[0], 600000), /Wait for the round/);
  g.start();
  g.lockHeight(pks[0], 600000); // exact, at once
  assert.throws(() => g.lockHeight(pks[0], 1), /already locked/);
  assert.throws(() => g.lockHeight(pks[1], -5), /dial/);
  const len = g.settings.gameSeconds * 1000;
  advance(len / 2);
  g.lockHeight(pks[1], 600000 + 52_560); // a year late, halfway through
  const st = g.publicState();
  assert.deepEqual(st.locked.sort(), [pks[0], pks[1]].sort());
  assert.ok(!JSON.stringify(st).includes("652560"), "the guesses aren't public before the end");
  g.lockHeight(pks[2], 0); // way off; and now everyone's in
  assert.equal(g.phase, "final");
  const f = g.s.final!;
  assert.equal(f.reason, "all");
  assert.equal(f.height, 600000);
  const pts = Object.fromEntries(f.guesses!.map((x) => [x.pk, x.points]));
  assert.equal(pts[pks[0]], 100);
  assert.equal(pts[pks[1]], guessPoints(600000 + 52_560, 600000, 0.5));
  assert.equal(pts[pks[2]], guessPoints(0, 600000, 0.5), "way off still scores a little");
  assert.ok(pts[pks[2]] > 0);
  assert.equal(g.s.show.totals[pks[0]], 100);
});

test("after round 3: the 3 Ship Showdown for the top 3; its winner takes the treasure and can claim it", async () => {
  const { g, pks, advance } = await heightShow(5);
  const scorer = [0, 1, 2];
  for (let r = 0; r < 3; r++) {
    if (r) await g.nextRound();
    g.start();
    g.lockHeight(pks[scorer[r]], g.puzzleInfo.height!);
    advance(g.settings.gameSeconds * 1000 - 500);
    g.lockHeight(pks[3], Math.max(0, g.puzzleInfo.height! - 52_560 * 4)); // way off and last-second: a few points
    advance(1000);
    assert.equal(g.s.final!.stage, "prelim");
  }
  await g.nextRound(); // after round 3, "next" is the final
  assert.equal(g.puzzleInfo.id, "fin");
  assert.equal(g.s.show.stage, "final");
  assert.deepEqual(g.s.show.finalists.slice().sort(), [pks[0], pks[1], pks[2]].sort());
  g.start();
  assert.throws(() => g.lockHeight(pks[4], 1), /watching/);
  g.lockHeight(pks[2], 150000);
  g.lockHeight(pks[0], 150000 + 52_560);
  g.lockHeight(pks[1], 0); // all three finalists in: it ends
  const f = g.s.final!;
  assert.equal(f.stage, "final");
  assert.equal(f.ranking[0].pk, pks[2]);
  assert.equal(f.ranking[0].share, g.settings.prizePool, "winner takes all");
  await assert.rejects(() => g.nextRound(), /final has started/);
  assert.match(g.claimPrize(pks[2], "w@walletofsatoshi.com").message, /^prize/);
});

test("slabs: a few per player, some already off at the start", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-tiles-"));
  const g = new Game({ dataDir, imagesDir: join(dataDir, "none"), puzzles: PUZZLES });
  await g.init();
  await g.setSettings({ tilesPerPlayer: 4, preFallen: 0.12 });
  for (let i = 0; i < 10; i++) g.join((i + 1).toString(16).padStart(64, "e"), `T${i}`);
  await g.newGame("r1");
  const n = g.s.tiles.length;
  assert.ok(n >= 34 && n <= 46, `about 40 slabs for 10 players (${n})`);
  const off = g.s.fallen.filter((x) => x !== false).length;
  assert.ok(off >= 3 && off <= 7, `about 12% already off (${off})`);
  for (const pk of Object.keys(g.s.players).slice(2)) g.removePlayer(pk);
  await g.newGame("r1");
  assert.ok(g.s.tiles.length >= 18, `never fewer than about 20 (${g.s.tiles.length})`);
});

test("the countdown: 3-2-1, then the cannons fire; the clock starts after it", async () => {
  const { g, pks, advance } = await heightShow(2);
  await g.setSettings({ countdownSeconds: 3 });
  g.start();
  const st = g.publicState();
  assert.equal(st.goAt - st.now, 3000);
  assert.equal(st.deadline - st.goAt, g.settings.gameSeconds * 1000, "the full round comes after the countdown");
  assert.throws(() => g.lockHeight(pks[0], 600000), /Get ready/);
  assert.throws(() => g.fire(pks[0], 0, 0.3), /Get ready/);
  advance(3000);
  assert.match(g.lockHeight(pks[0], 600000).message, /^locked/);
});

test("joining with a pirate avatar puts it on the ship; badges are remembered per player", async () => {
  const { g, pks } = await setup(2);
  g.join("f".repeat(64), "Avatarbeard", { avatar: 7 });
  assert.equal(g.s.players["f".repeat(64)].picture, "/avatars/7.svg");
  g.join("e".repeat(64), "Nope", { avatar: 99 });
  assert.equal(g.s.players["e".repeat(64)].picture, undefined, "only the 16 avatars");
  g.giveBadge(pks[0], "round");
  g.giveBadge(pks[0], "round");
  assert.deepEqual(g.publicState().badges, { [pks[0]]: ["round"] });
});

test("Lightning address → invoice: checks the amount in the invoice", async () => {
  const { invoiceFor } = await import("../src/server/wallet.ts");
  await assert.rejects(() => invoiceFor("not an address", 10), /Lightning address/);
});

test("a wall re-cut for new players never undoes a round the host just started", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-recut-"));
  const g = new Game({ dataDir, imagesDir: join(dataDir, "none"), puzzles: PUZZLES });
  await g.init();
  await g.setSettings({ tilesPerPlayer: 4, countdownSeconds: 0 });
  g.join("1".padStart(64, "a"), "A");
  const recut = g.newGame(g.s.puzzleId, { onlyIfLobby: true }); // as if a join set off a re-cut
  g.start();
  await recut;
  assert.equal(g.phase, "open", "the round is still running");
});
