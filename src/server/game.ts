// The game itself: one shared puzzle painted on a cliff and covered in rock slabs.
// Everyone plays at once: fire your cannon to knock slabs off (a slab you hit shows you
// what's behind it a few seconds before everyone else), and type guesses at any time.
// Letters of the phrase also appear by themselves as the game goes on.
// The server is the referee. Actions are handled one at a time in the order they arrive,
// so if two players type the same word, the first one to reach the server gets it.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type FeedItem, type FinalInfo, type KrakenInfo, type Phase, type Pirate, PIRATES_EACH, type PubState, type Settings, type ShowInfo, type Shot } from "../shared/types.ts";
import { cove, inPolygon, landing, shipAt } from "../shared/cannon.ts";
import { guessPoints, timeToHeight } from "../shared/blocks.ts";
import { matchGuess, parsePhrase, tokens, type Word } from "./match.ts";
import { PUZZLES, type Puzzle } from "./puzzles.ts";
import { cutPuzzle, findImage, saveReveal, type Tile } from "./tiles.ts";

export class GameError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface Player {
  name: string;
  slot: number;
  picture?: string;
  npub?: string;
  points: number;
  shots: number;
  hits: number;
  bot?: boolean;
  joinedAt: number;
}

interface Saved {
  version: 2;
  v: number;
  settings: Settings;
  gameId: string;
  puzzleId: string;
  salt: string;
  commitment: string;
  image: { w: number; h: number };
  tiles: Tile[];
  fullToken: string;
  fallen: (string | null | false)[]; // false = still up; null = fell by itself; pubkey = knocked off by
  found: ({ pk: string; points: number } | null)[];
  letters: Record<number, string>[];
  cluesOut: number;
  players: Record<string, Player>;
  phase: Phase;
  deadline: number;
  paused?: { at: number };
  locks: Record<string, number>;
  lastShot: Record<string, number>;
  cracking: Record<number, { pk: string; until: number }>;
  peeks: Record<string, number>; // private link token -> tile
  nextTileAt: number;
  nextLetterAt: number;
  nextClueAt: number;
  nextWindAt: number;
  wind: number;
  misses: number;
  missCounts: Record<string, number>;
  shots: Shot[];
  feed: FeedItem[];
  seq: number;
  final?: FinalInfo;
  show: ShowInfo & {
    played: string[];
    /** winners' Lightning addresses and how paying them went: host only, never published */
    payouts?: Record<string, Payout>;
    /** Nostr badges won this show (only players signed in with Nostr) */
    badges?: Record<string, string[]>;
  };
  startedAt: number;
  kraken?: KrakenInfo;
  krakenDone: boolean;
  letterPeeks: { pk: string; word: number; pos: number; until: number }[];
  targetBackAt: number;
  /** The finished picture's file name, if this puzzle has one. */
  revealToken?: string;
  pirates: Pirate[];
  /** The countdown ends here: no shots or guesses before it. */
  goAt?: number;
  /** Block-height rounds: each player's locked-in guess (secret until the round ends). */
  locked: Record<string, { height: number; at: number; /** share of the round still to go */ share: number }>;
}

export interface Payout {
  /** a Lightning address, or "scan to receive" (the winner's wallet pulls it with the QR) */
  address: string;
  /** scan to receive: the one-time code in the QR */
  token?: string;
  sats: number;
  status: "waiting" | "paying" | "paid" | "failed";
  error?: string;
}

export interface GameOptions {
  dataDir: string;
  imagesDir: string;
  now?: () => number;
  random?: () => number;
  puzzles?: Puzzle[];
}

export interface Result {
  ok: boolean;
  message: string;
}

const MAX_FEED = 40;
const MAX_SHOTS = 40;
const WIND_EVERY = 30_000;

export class Game {
  s!: Saved;
  private words: Word[] = [];
  private puzzle!: Puzzle;
  private readonly file: string;
  private listeners = new Set<() => void>();
  readonly now: () => number;
  private readonly random: () => number;
  readonly puzzles: Puzzle[];
  /** Is the game's own wallet connected (pays the winner automatically)? Set by the server. */
  autoPay = false;
  /** The current Bitcoin block height (the server refreshes it from a block explorer). */
  tipHeight = timeToHeight(Date.now());
  private recutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: GameOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.puzzles = opts.puzzles ?? PUZZLES;
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, "game.json");
  }

  /** Load the saved game, or set up the first puzzle. */
  async init() {
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
      const p = this.puzzles.find((x) => x.id === saved.puzzleId);
      if (p && saved.version === 2) {
        saved.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
        saved.show ??= { stage: "prelim", round: 1, totals: {}, finalists: [], played: [saved.puzzleId], eliminated: [] };
        saved.show.eliminated ??= [];
        saved.letterPeeks ??= [];
        saved.targetBackAt ??= 0;
        saved.pirates ??= [];
        saved.locked ??= {};
        this.s = saved;
        this.puzzle = p;
        this.words = parsePhrase(p);
        return;
      }
    }
    this.s = { settings: { ...DEFAULT_SETTINGS }, players: {}, v: 0, seq: 0, show: { stage: "prelim", round: 1, totals: {}, finalists: [], played: [], eliminated: [] } } as unknown as Saved;
    await this.newGame(this.puzzles[0].id);
  }

  onChange(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    this.s.v++;
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.s));
    renameSync(tmp, this.file);
    for (const cb of this.listeners) cb();
  }

  get settings() {
    return this.s.settings;
  }
  get phase() {
    return this.s.phase;
  }
  get puzzleInfo() {
    return this.puzzle;
  }
  /** Is this round "guess the block height"? */
  get heightMode() {
    return this.puzzle.height !== undefined;
  }
  get hiddenWords() {
    return this.words.map((w, i) => ({ ...w, i })).filter((w) => !w.given);
  }
  /** This round's pace: the puzzle's own timing, falling back to the host's settings. */
  get pace() {
    const st = this.s.settings;
    const t = this.puzzle.timing ?? {};
    return {
      roundSeconds: t.roundSeconds ?? st.gameSeconds,
      tileEverySeconds: t.tileEverySeconds ?? st.tileEverySeconds,
      firstLetterSeconds: t.firstLetterSeconds ?? st.letterEverySeconds,
      letterEverySeconds: t.letterEverySeconds ?? st.letterEverySeconds,
      clueEverySeconds: t.clueEverySeconds ?? st.clueEverySeconds,
    };
  }

  get cove() {
    return cove(this.s.image.w, this.s.image.h);
  }

  // ───────────── setting up ─────────────

  async newGame(puzzleId?: string, opts: { onlyIfLobby?: boolean } = {}) {
    const p = this.puzzles.find((x) => x.id === (puzzleId || this.s.puzzleId)) ?? this.puzzles[0];
    const gameId = randomBytes(6).toString("hex");
    const gamesDir = join(this.opts.dataDir, "games");
    const cut = await cutPuzzle(p, this.opts.imagesDir, join(gamesDir, gameId), this.tileTarget(p), Math.floor(this.random() * 2 ** 31));
    const revealToken = await saveReveal(p, this.opts.imagesDir, join(gamesDir, gameId), cut.w, cut.h);
    // a re-cut for a new player count is dropped if the host started the round meanwhile
    if (opts.onlyIfLobby && this.s.phase !== "lobby") return;
    // Keep only the newest couple of games' pictures on disk.
    if (existsSync(gamesDir)) {
      for (const d of readdirSync(gamesDir)) if (d !== gameId && d !== this.s.gameId) rmSync(join(gamesDir, d), { recursive: true, force: true });
    }
    const words = parsePhrase(p);
    const salt = randomBytes(16).toString("hex");
    const answer = words.map((w) => w.text).join(" ");
    const players = this.s.players ?? {};
    for (const pl of Object.values(players)) Object.assign(pl, { points: 0, shots: 0, hits: 0 });
    // The funny setup is uncovered from the start; the punchline stays hidden.
    const fallen = cut.tiles.map((t) => {
      const cx = t.points.reduce((a, q) => a + q[0], 0) / t.points.length / cut.w;
      const cy = t.points.reduce((a, q) => a + q[1], 0) / t.points.length / cut.h;
      const inside = (r: [number, number, number, number]) => cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3];
      if (p.hide) return inside(p.hide) ? (false as const) : null; // only the middle starts covered
      if (!p.start) return false as const;
      return inside(p.start) ? null : (false as const);
    });
    // A few slabs are already off when the round starts, so there's a hint from the first second.
    if (!p.start && !p.hide && this.s.settings.preFallen > 0) {
      const up = fallen.map((_, i) => i);
      for (let n = Math.round(up.length * this.s.settings.preFallen); n > 0 && up.length; n--) fallen[up.splice(Math.floor(this.random() * up.length), 1)[0]] = null;
    }
    // Like the letters given away in Wheel of Fortune's bonus round: the show's own letters.
    const free = new Set(this.s.settings.freeLetters.toUpperCase().replace(/[^A-Z0-9]/g, ""));
    const letters = words.map((w) => {
      const out: Record<number, string> = {};
      if (w.given) return out;
      [...w.text].forEach((ch, k) => free.has(ch) && (out[k] = ch));
      // never give a whole word away
      if (Object.keys(out).length >= w.text.length) delete out[Number(Object.keys(out)[0])];
      return out;
    });
    this.puzzle = p;
    this.words = words;
    this.s = {
      version: 2,
      v: this.s.v ?? 0,
      settings: this.s.settings,
      gameId,
      puzzleId: p.id,
      salt,
      commitment: sha256(`${salt}|${answer}`),
      image: { w: cut.w, h: cut.h },
      tiles: cut.tiles,
      fullToken: cut.fullToken,
      fallen,
      found: words.map(() => null),
      letters,
      cluesOut: 0,
      players,
      phase: "lobby",
      deadline: 0,
      locks: {},
      lastShot: {},
      cracking: {},
      peeks: {},
      nextTileAt: 0,
      nextLetterAt: 0,
      nextClueAt: 0,
      nextWindAt: 0,
      wind: 0,
      misses: 0,
      missCounts: {},
      shots: [],
      feed: [],
      seq: this.s.seq ?? 0,
      show: this.s.show ?? { stage: "prelim", round: 0, totals: {}, finalists: [], played: [], eliminated: [] },
      startedAt: 0,
      krakenDone: false,
      letterPeeks: [],
      targetBackAt: 0,
      ...(revealToken ? { revealToken } : {}),
      pirates: [],
      locked: {},
    };
    this.s.show.eliminated ??= [];
    this.s.show.played = [...new Set([...this.s.show.played, p.id])];
    this.changed();
  }

  /** How many slabs: per player for block-height rounds (so the picture opens up in ~15 s), else fixed. */
  private tileTarget(p: Puzzle) {
    const st = this.s.settings;
    if (p.tiles) return p.tiles;
    if (p.height === undefined || !st.tilesPerPlayer) return st.tiles;
    const n = Object.keys(this.s.players ?? {}).filter((pk) => !(this.s.show?.eliminated ?? []).includes(pk)).length;
    return Math.max(20, Math.min(100, Math.round(st.tilesPerPlayer * Math.max(1, n))));
  }

  /** While waiting to start, re-cut the picture when enough people have joined or left to matter. */
  private scheduleRecut() {
    if (this.s.phase !== "lobby" || !this.heightMode || !this.s.settings.tilesPerPlayer) return;
    if (this.recutTimer) clearTimeout(this.recutTimer);
    this.recutTimer = setTimeout(() => {
      this.recutTimer = null;
      if (this.s.phase !== "lobby") return;
      const want = this.tileTarget(this.puzzle);
      if (Math.abs(want - this.s.tiles.length) / Math.max(want, 1) < 0.15) return;
      this.newGame(this.s.puzzleId, { onlyIfLobby: true }).catch(() => {});
    }, 1500);
    (this.recutTimer as { unref?: () => void }).unref?.();
  }

  // ───────────── the show: prelim rounds, then the final ─────────────

  /** Load the next prelim round: the chosen puzzle, or the next one not played yet in this show. */
  async nextRound(puzzleId?: string) {
    if (this.s.phase === "open" || this.s.phase === "paused") throw new GameError("Finish this round first");
    if (this.s.show.stage === "final") throw new GameError("The final has started: start a new show for more rounds");
    // after the last prelim round, "next" is the final showdown (if the show has one)
    if (!puzzleId && !this.prelimLeft()) {
      if (this.puzzles.some((p) => p.finalOnly)) return this.startFinal();
      throw new GameError("That was the last round: start a new show");
    }
    const id = puzzleId || this.nextPuzzle();
    this.s.show.round++;
    await this.newGame(id);
  }

  /** The top 3 by show total go to the final; everyone else watches. */
  async startFinal(puzzleId?: string) {
    if (this.s.phase === "open" || this.s.phase === "paused") throw new GameError("Finish this round first");
    const ranked = Object.keys(this.s.players).filter((pk) => !this.s.show.eliminated.includes(pk)).sort((a, b) => (this.s.show.totals[b] ?? 0) - (this.s.show.totals[a] ?? 0) || this.s.players[a].slot - this.s.players[b].slot);
    if (!ranked.length) throw new GameError("Nobody is aboard");
    this.s.show.stage = "final";
    this.s.show.finalists = ranked.slice(0, 3);
    await this.newGame(puzzleId || this.nextPuzzle(true));
  }

  /** Start over: totals cleared, back to round 1. Players stay aboard. */
  async newShow(puzzleId?: string) {
    if (this.s.phase === "open" || this.s.phase === "paused") throw new GameError("Finish this round first");
    this.s.show = { stage: "prelim", round: 1, totals: {}, finalists: [], played: [], eliminated: [] };
    await this.newGame(puzzleId || this.puzzles[0].id);
  }

  /** How many prelim rounds haven't been played yet in this show. */
  prelimLeft() {
    return this.puzzles.filter((p) => !p.finalOnly && !this.s.show.played.includes(p.id)).length;
  }

  /** The next puzzle not played yet in this show; puzzles saved for the final only go in the final. */
  private nextPuzzle(final = false) {
    const fresh = this.puzzles.filter((p) => !this.s.show.played.includes(p.id) && !!p.finalOnly === final);
    // puzzles with a real picture first
    const ready = fresh.filter((p) => findImage(this.opts.imagesDir, p.id));
    return (ready[0] ?? fresh[0] ?? this.puzzles[0]).id;
  }

  private canPlay(pk: string) {
    if (this.s.show.eliminated.includes(pk)) return false;
    return this.s.show.stage !== "final" || this.s.show.finalists.includes(pk);
  }

  /** Players still in the show (not dragged under). */
  private alive() {
    return Object.keys(this.s.players).filter((pk) => !this.s.show.eliminated.includes(pk));
  }

  /** Points so far in the show, counting this round. */
  private standing(pk: string) {
    return (this.s.show.totals[pk] ?? 0) + (this.s.players[pk]?.points ?? 0);
  }

  /**
   * The kraken wakes: the bottom third (by points so far; ties broken at random) go into a
   * lottery, half of them (rounded up) are dragged under. Play stops while it happens.
   */
  private wakeKraken(now: number) {
    this.s.krakenDone = true;
    const alive = this.alive();
    const st = this.s.settings;
    if (alive.length < Math.max(4, st.krakenMinPlayers)) return false;
    // lowest scores first; ties in a random order
    const shuffled = alive.map((pk) => [pk, this.random()] as const).sort((a, b) => a[1] - b[1]).map(([pk]) => pk);
    const byScore = shuffled.sort((a, b) => this.standing(a) - this.standing(b));
    const cfg = typeof this.puzzle.kraken === "object" ? this.puzzle.kraken : {};
    if (cfg.bottomShare) {
      // this round: the bottom share of the boats, no lottery (never fewer than 3 left)
      const take = Math.min(Math.max(1, Math.round(alive.length * cfg.bottomShare)), alive.length - 3);
      if (take <= 0) return false;
      const doomed = byScore.slice(0, take);
      this.s.kraken = { at: now, until: now + 7_000, candidates: doomed, doomed, lottery: false };
      this.s.phase = "kraken";
      return true;
    }
    const bottom = byScore.slice(0, Math.max(2, Math.floor(alive.length / 3)));
    const order = bottom.map((pk) => [pk, this.random()] as const).sort((a, b) => a[1] - b[1]).map(([pk]) => pk);
    // never leave fewer than 3 for the final
    const take = Math.min(Math.ceil(order.length / 2), alive.length - 3);
    if (take <= 0) return false;
    const doomed = order.slice(0, take);
    this.s.kraken = { at: now, until: now + 11_000, candidates: order, doomed, lottery: true };
    this.s.phase = "kraken";
    return true;
  }

  /** The kraken has had its meal: the doomed are out, and every clock moves on by the pause. */
  private krakenDone(now: number) {
    const k = this.s.kraken!;
    for (const pk of k.doomed) if (!this.s.show.eliminated.includes(pk)) this.s.show.eliminated.push(pk);
    const shift = now - k.at;
    this.s.deadline += shift;
    this.s.nextTileAt += shift;
    this.s.nextLetterAt += shift;
    this.s.nextClueAt += shift;
    this.s.nextWindAt += shift;
    for (const c of Object.values(this.s.cracking)) c.until += shift;
    for (const key of Object.keys(this.s.locks)) this.s.locks[key] += shift;
    for (const lp of this.s.letterPeeks) lp.until += shift;
    this.s.targetBackAt += shift;
    this.s.phase = "open";
  }

  /** Change the rules. A new tile count or free-letter set reloads the puzzle (between games). */
  async setSettings(patch: Partial<Settings>) {
    const next: Settings = { ...this.s.settings, ...patch };
    const between = ["lobby", "final"].includes(this.s.phase);
    next.prizeSplit = next.prizeSplit === "winner" ? "winner" : "points";
    num(next, "gameSeconds", 20, 1200);
    num(next, "finalSeconds", 20, 1200);
    num(next, "hitPoints", 0, 50);
    num(next, "krakenAfterSeconds", 5, 600);
    num(next, "krakenRounds", 0, 20);
    num(next, "krakenMinPlayers", 4, 1000);
    num(next, "tiles", 6, 120);
    num(next, "reloadSeconds", 0, 30);
    num(next, "peekSeconds", 0, 30);
    num(next, "targetCooldownSeconds", 0, 300);
    num(next, "lockoutSeconds", 0, 30);
    num(next, "tileEverySeconds", 0, 300);
    num(next, "letterEverySeconds", 0, 300);
    num(next, "clueEverySeconds", 0, 600);
    num(next, "solveBonus", 0, 1000);
    num(next, "prizePool", 0, 100_000_000);
    num(next, "tilesPerPlayer", 0, 20);
    num(next, "countdownSeconds", 0, 10);
    num(next, "maxPoints", 1, 10_000);
    next.preFallen = Math.min(0.5, Math.max(0, Number(next.preFallen) || 0));
    next.zeroYears = Math.min(20, Math.max(0.25, Number(next.zeroYears) || 3));
    next.title = String(next.title).slice(0, 60);
    next.tagline = String(next.tagline).slice(0, 100);
    next.freeLetters = String(next.freeLetters ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 26);
    const reload = ["tiles", "freeLetters", "tilesPerPlayer", "preFallen"].some((k) => next[k as keyof Settings] !== this.s.settings[k as keyof Settings]);
    this.s.settings = next;
    if (reload && between) return this.newGame(this.s.puzzleId);
    this.changed();
  }

  // ───────────── players ─────────────

  join(pk: string, rawName: string, opts: { bot?: boolean; avatar?: number } = {}): Result {
    const name = cleanName(rawName);
    if (!name) throw new GameError("Pick a name");
    // one of the pirate avatars (public/avatars/1–16.svg): painted on your ship's sail
    const avatar = Number.isInteger(opts.avatar) && opts.avatar! >= 1 && opts.avatar! <= 16 ? `/avatars/${opts.avatar}.svg` : undefined;
    const existing = this.s.players[pk];
    if (existing) {
      if (avatar && !existing.npub) existing.picture = avatar;
      if (existing.name !== name) existing.name = this.uniqueName(name, pk);
      this.changed();
      return { ok: true, message: `aboard: ${existing.name}` };
    }
    const used = new Set(Object.values(this.s.players).map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    this.s.players[pk] = { name: this.uniqueName(name, pk), slot, points: 0, shots: 0, hits: 0, joinedAt: this.now(), ...(avatar ? { picture: avatar } : {}), ...(opts.bot ? { bot: true } : {}) };
    this.changed();
    this.scheduleRecut();
    return { ok: true, message: `aboard: ${this.s.players[pk].name}` };
  }

  /** A real Nostr identity vouched for this device: show its name and picture. */
  link(pk: string, npub: string, profile: { name?: string; picture?: string }) {
    const pl = this.s.players[pk];
    if (!pl) throw new GameError("Join first");
    pl.npub = npub;
    if (profile.name) pl.name = this.uniqueName(cleanName(profile.name) || pl.name, pk);
    if (profile.picture && /^https:\/\//.test(profile.picture)) pl.picture = profile.picture.slice(0, 500);
    this.changed();
  }

  removePlayer(pk: string) {
    delete this.s.players[pk];
    this.changed();
    this.scheduleRecut();
  }

  /** Everyone off the ship (test lab). Only between games. */
  clearPlayers() {
    if (!["lobby", "final"].includes(this.s.phase)) throw new GameError("Finish or reload the game first");
    this.s.players = {};
    this.changed();
    this.scheduleRecut();
  }

  private uniqueName(name: string, pk: string) {
    const taken = new Set(Object.entries(this.s.players).filter(([k]) => k !== pk).map(([, p]) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
  }

  // ───────────── running the clock ─────────────

  start() {
    if (this.s.phase !== "lobby") throw new GameError("The game has already started");
    if (!Object.keys(this.s.players).length) throw new GameError("Nobody has joined yet");
    const now = this.now();
    const st = this.s.settings;
    this.s.phase = "open";
    // 3, 2, 1… then fire the cannons: every clock starts when the countdown ends
    const go = now + st.countdownSeconds * 1000;
    this.s.goAt = go;
    this.s.startedAt = go;
    this.s.krakenDone = false;
    const pace = this.pace;
    this.s.deadline = go + (this.s.show.stage === "final" ? st.finalSeconds : pace.roundSeconds) * 1000;
    this.s.nextTileAt = go + pace.tileEverySeconds * 1000;
    this.s.nextLetterAt = go + pace.firstLetterSeconds * 1000;
    this.s.nextClueAt = go + pace.clueEverySeconds * 1000;
    this.s.nextWindAt = go + WIND_EVERY;
    this.s.wind = this.newWind();
    this.changed();
  }

  /** Called several times a second; moves the game along when a timer comes due. */
  tick() {
    const now = this.now();
    if (this.s.phase === "kraken") {
      if (this.s.kraken && now >= this.s.kraken.until) {
        this.krakenDone(now);
        this.changed();
      }
      return;
    }
    if (this.s.phase !== "open") return;
    if (now >= this.s.deadline) return this.finish("time");
    const st = this.s.settings;
    const sh = this.s.show;
    const krakenAfter = (typeof this.puzzle.kraken === "object" && this.puzzle.kraken.afterSeconds) || st.krakenAfterSeconds;
    if (!this.s.krakenDone && this.puzzle.kraken !== false && sh.stage === "prelim" && sh.round <= st.krakenRounds && now - this.s.startedAt >= krakenAfter * 1000) {
      if (this.wakeKraken(now)) return this.changed();
    }
    let dirty = false;
    for (const [k, c] of Object.entries(this.s.cracking)) {
      if (now >= c.until) {
        this.s.fallen[Number(k)] = c.pk;
        delete this.s.cracking[Number(k)];
        dirty = true;
      }
    }
    for (const lp of this.s.letterPeeks.filter((x) => now >= x.until)) {
      this.s.letters[lp.word][lp.pos] = this.words[lp.word].text[lp.pos];
      this.s.letterPeeks.splice(this.s.letterPeeks.indexOf(lp), 1);
      dirty = true;
    }
    const pace = this.pace;
    if (pace.tileEverySeconds > 0 && now >= this.s.nextTileAt) {
      this.dropRandomTile();
      this.s.nextTileAt = now + pace.tileEverySeconds * 1000;
      dirty = true;
    }
    if (pace.letterEverySeconds > 0 && this.puzzle.autoLetters !== false && !this.heightMode && now >= this.s.nextLetterAt) {
      dirty = this.revealRandomLetter() || dirty;
      this.s.nextLetterAt = now + pace.letterEverySeconds * 1000;
    }
    if (pace.clueEverySeconds > 0 && now >= this.s.nextClueAt) {
      if (this.s.cluesOut < this.puzzle.clues.length) {
        this.s.cluesOut++;
        this.addFeed({ pk: "", kind: "clue", text: this.puzzle.clues[this.s.cluesOut - 1] });
        dirty = true;
      }
      this.s.nextClueAt = now + pace.clueEverySeconds * 1000;
    }
    if (now >= this.s.nextWindAt) {
      this.s.wind = this.newWind();
      this.s.nextWindAt = now + WIND_EVERY;
      dirty = true;
    }
    for (const [k, until] of Object.entries(this.s.locks)) if (until <= now) delete this.s.locks[k];
    if (dirty) this.changed();
  }

  private newWind() {
    return Math.round((this.random() * 2 - 1) * 80) / 100; // -0.8..0.8
  }

  pause() {
    if (this.s.phase !== "open") throw new GameError("Nothing to pause");
    this.s.paused = { at: this.now() };
    this.s.phase = "paused";
    this.changed();
  }

  /** Every clock moves forward by however long the pause lasted. */
  resume() {
    if (this.s.phase !== "paused" || !this.s.paused) throw new GameError("Not paused");
    const shift = this.now() - this.s.paused.at;
    this.s.phase = "open";
    this.s.deadline += shift;
    this.s.nextTileAt += shift;
    this.s.nextLetterAt += shift;
    this.s.nextClueAt += shift;
    this.s.nextWindAt += shift;
    for (const c of Object.values(this.s.cracking)) c.until += shift;
    for (const k of Object.keys(this.s.locks)) this.s.locks[k] += shift;
    for (const lp of this.s.letterPeeks) lp.until += shift;
    this.s.targetBackAt += shift;
    if (this.s.goAt) this.s.goAt += shift;
    this.s.paused = undefined;
    this.changed();
  }

  addTime(seconds: number) {
    if (this.s.phase !== "open") throw new GameError("Nothing running");
    this.s.deadline += clamp(seconds, 1, 300) * 1000;
    this.changed();
  }

  end() {
    if (this.s.phase === "final") throw new GameError("Already over");
    if (this.s.phase === "lobby") throw new GameError("The game hasn't started");
    this.finish("host");
  }

  private finish(reason: FinalInfo["reason"], solvedBy?: string) {
    const stage = this.s.show.stage;
    const st = this.s.settings;
    // Block-height rounds: every locked-in guess is scored now: closer and sooner score more.
    let guesses: FinalInfo["guesses"];
    if (this.heightMode) {
      const answer = this.puzzle.height!;
      guesses = Object.entries(this.s.locked)
        .filter(([pk]) => this.s.players[pk])
        .map(([pk, g]) => ({ pk, height: g.height, off: g.height - answer, points: guessPoints(g.height, answer, g.share, st.maxPoints) }))
        .sort((a, b) => b.points - a.points || Math.abs(a.off) - Math.abs(b.off));
      for (const g of guesses) this.s.players[g.pk].points += g.points;
    }
    // The last round of a show with no separate final: the show total decides who gets the treasure.
    const last = stage === "prelim" && !this.prelimLeft() && !this.puzzles.some((p) => p.finalOnly);
    // Prelim rounds are qualifiers: they add to the show totals and pay nothing.
    const pool = stage === "final" || last ? st.prizePool : 0;
    if (stage === "prelim") for (const [pk, p] of Object.entries(this.s.players)) if (p.points) this.s.show.totals[pk] = (this.s.show.totals[pk] ?? 0) + p.points;
    const scoreOf = (pk: string) => (last ? (this.s.show.totals[pk] ?? 0) : this.s.players[pk].points);
    const scored = Object.keys(this.s.players)
      .filter((pk) => scoreOf(pk) > 0 && this.canPlay(pk))
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    const total = scored.reduce((n, pk) => n + scoreOf(pk), 0);
    const best = scored.length ? scoreOf(scored[0]) : 0;
    const tops = scored.filter((pk) => scoreOf(pk) === best).length;
    this.s.final = {
      reason,
      ranking: scored.map((pk) => ({
        pk,
        points: scoreOf(pk),
        share: st.prizeSplit === "winner" ? (scoreOf(pk) === best ? Math.floor(pool / tops) : 0) : Math.floor((pool * scoreOf(pk)) / total),
      })),
      stage: last ? "final" : stage,
      ...(last ? { showOver: true } : {}),
      ...(this.heightMode ? { height: this.puzzle.height, when: this.puzzle.when, event: this.puzzle.event, guesses } : {}),
      ...(solvedBy ? { solvedBy } : {}),
      answer: this.words.map((w) => w.text).join(" "),
      salt: this.s.salt,
      imageUrl: `/tile/${this.s.gameId}/${this.s.fullToken}.jpg`,
      // the glorious reveal: only when someone actually solves it
      ...(reason === "solved" && this.s.revealToken ? { revealUrl: `/tile/${this.s.gameId}/${this.s.revealToken}.jpg` } : {}),
    };
    this.s.phase = "final";
    this.s.deadline = 0;
    this.s.cracking = {};
    this.s.letterPeeks = [];
    this.changed();
    try {
      this.onFinish?.(this.s.final);
    } catch (e) {
      console.error(e);
    }
  }

  // ───────────── guessing ─────────────

  /** Block-height rounds: lock in a guess. One per round; it's scored when the round ends. */
  lockHeight(pk: string, raw: number): Result {
    if (!this.s.players[pk]) throw new GameError("Join the game first");
    if (!this.heightMode) throw new GameError("This round isn't a block-height round");
    if (this.s.phase === "paused") throw new GameError("The game is paused");
    if (this.s.phase !== "open") throw new GameError("Wait for the round to start");
    if (!this.canPlay(pk)) throw new GameError("You're watching this round");
    if (this.now() < (this.s.goAt ?? 0)) throw new GameError("Get ready…");
    if (this.s.locked[pk]) throw new GameError("You've already locked in");
    const height = Math.round(Number(raw));
    if (!Number.isFinite(height) || height < 0 || height > this.tipHeight + 5000) throw new GameError("Pick a block height on the dial");
    const now = this.now();
    const len = (this.s.show.stage === "final" ? this.s.settings.finalSeconds : this.pace.roundSeconds) * 1000;
    this.s.locked[pk] = { height, at: now, share: Math.max(0, Math.min(1, (this.s.deadline - now) / len)) };
    // everyone's in: no need to wait for the clock
    if (this.alive().every((k) => !this.canPlay(k) || this.s.locked[k])) {
      this.finish("all");
      return { ok: true, message: `locked: ${height}` };
    }
    this.changed();
    return { ok: true, message: `locked: ${height}` };
  }

  guess(pk: string, raw: string): Result {
    const pl = this.s.players[pk];
    if (!pl) throw new GameError("Join the game first");
    if (this.heightMode) throw new GameError("Use the dial to guess the block height");
    if (this.s.phase === "paused") throw new GameError("The game is paused");
    if (this.s.phase === "kraken") throw new GameError("The kraken stirs… hold on!");
    if (this.s.phase !== "open") throw new GameError("Wait for the game to start");
    if (this.s.show.eliminated.includes(pk)) throw new GameError("The kraken dragged you under: you're watching now");
    if (!this.canPlay(pk)) throw new GameError("Only the three finalists play the final: cheer them on!");
    const left = (this.s.locks[pk] ?? 0) - this.now();
    if (left > 0) throw new GameError(`Wrong guess: wait ${Math.ceil(left / 1000)}s`);
    const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) throw new GameError("Type a word or the whole phrase");
    const hits = matchGuess(this.words, text);
    const fresh = hits.filter((i) => !this.s.found[i]);
    if (hits.length && !fresh.length) return { ok: false, message: "duplicate: already on the board, try another word" };
    if (!fresh.length) {
      this.s.locks[pk] = this.now() + this.s.settings.lockoutSeconds * 1000;
      this.s.misses++;
      const key = tokens(text).join(" ").toUpperCase().slice(0, 30);
      if (key) this.s.missCounts[key] = (this.s.missCounts[key] ?? 0) + 1;
      this.addFeed({ pk, kind: "miss", text });
      this.changed();
      return { ok: true, message: "miss" };
    }
    let points = 0;
    for (const i of fresh) {
      const p = this.puzzle.points ?? this.words[i].text.length;
      this.s.found[i] = { pk, points: p };
      points += p;
    }
    const solved = this.s.found.every((f, i) => f || this.words[i].given);
    if (solved) points += this.s.settings.solveBonus;
    pl.points += points;
    this.addFeed({ pk, kind: solved ? "solve" : "hit", text, words: fresh.map((i) => this.words[i].text), points });
    if (solved) {
      this.finish("solved", pk);
      return { ok: true, message: `solved: ${fresh.map((i) => this.words[i].text).join(" ")} +${points}` };
    }
    this.changed();
    return { ok: true, message: `hit: ${fresh.map((i) => this.words[i].text).join(" ")} +${points}` };
  }

  // ───────────── cannons ─────────────

  /** Fire! The server decides where the ball lands, from wherever your ship is right now. */
  fire(pk: string, angle: number, power: number): Result {
    const pl = this.s.players[pk];
    if (!pl) throw new GameError("Join the game first");
    if (this.s.phase === "paused") throw new GameError("The game is paused");
    if (this.s.phase === "kraken") throw new GameError("The kraken stirs… hold fire!");
    // Between rounds anyone can fire practice shots: they fly, splash and set off the scenery,
    // but bounce off the slabs and don't count.
    const practice = this.s.phase === "lobby" || this.s.phase === "final";
    if (!practice && this.s.show.eliminated.includes(pk)) throw new GameError("The kraken dragged you under: you're watching now");
    if (!practice && !this.canPlay(pk)) throw new GameError("Only the three finalists play the final: cheer them on!");
    if (!Number.isFinite(angle) || !Number.isFinite(power)) throw new GameError("Aim first");
    if (!practice && this.now() < (this.s.goAt ?? 0)) throw new GameError("Get ready…");
    const now = this.now();
    const ready = (this.s.lastShot[pk] ?? 0) + this.s.settings.reloadSeconds * 1000 - 150;
    if (now < ready) throw new GameError("Reloading…");
    this.s.lastShot[pk] = now;
    const c = this.cove;
    const ship = shipAt(pl.slot, now / 1000, c);
    // the swell: every shot is nudged a little
    const land = landing(ship, angle + (this.random() - 0.5) * 3, power + (this.random() - 0.5) * 0.03, this.s.wind, c);
    let tile = -1;
    let result: Shot["result"] = land.result === "wall" ? (practice ? "rock" : "rubble") : land.result;
    if (practice) {
      this.s.shots.push({ id: ++this.s.seq, at: now, pk, from: { x: Math.round(ship.x), y: Math.round(ship.y) }, to: { x: Math.round(land.x), y: Math.round(land.y) }, result, tile, practice: true });
      if (this.s.shots.length > MAX_SHOTS) this.s.shots.splice(0, this.s.shots.length - MAX_SHOTS);
      this.changed();
      return { ok: true, message: `practice: ${land.result === "wall" ? "slab" : result}` };
    }
    if (land.result === "wall") {
      // scene units -> picture pixels (the picture is scaled to fit the cliff panel)
      const k = this.s.image.w / c.pic.w;
      const px = (land.x - c.pic.x) * k;
      const py = (land.y - c.pic.y) * k;
      const i = this.s.tiles.findIndex((t) => inPolygon(px, py, t.points));
      if (i >= 0 && this.s.fallen[i] === false && !this.s.cracking[i]) {
        tile = i;
        result = "hit";
      }
    }
    pl.shots++;
    this.s.shots.push({ id: ++this.s.seq, at: now, pk, from: { x: Math.round(ship.x), y: Math.round(ship.y) }, to: { x: Math.round(land.x), y: Math.round(land.y) }, result, tile });
    if (this.s.shots.length > MAX_SHOTS) this.s.shots.splice(0, this.s.shots.length - MAX_SHOTS);
    if (tile < 0) {
      this.changed();
      return { ok: true, message: result };
    }
    pl.hits++;
    pl.points += this.s.settings.hitPoints;
    const t = this.s.tiles[tile];
    const peek = randomBytes(16).toString("hex");
    this.s.peeks[peek] = tile;
    this.s.cracking[tile] = { pk, until: now + this.s.settings.peekSeconds * 1000 };
    this.changed();
    return { ok: true, message: `peek: ${JSON.stringify({ tile, url: `/tile/${this.s.gameId}/${peek}.webp`, x: t.x, y: t.y, w: t.w, h: t.h })}` };
  }

  // ───────────── pirates (the final only) ─────────────

  /**
   * Throw a pirate from your ship at a rival finalist's. Each finalist has two: the first goes
   * to the nearest rival ship. It lands on their screen and blocks
   * it for a few seconds. It changes no scores.
   */
  launchPirate(pk: string): Result {
    const pl = this.s.players[pk];
    if (!pl) throw new GameError("Join the game first");
    if (this.s.show.stage !== "final") throw new GameError("Pirates are only for the final");
    if (!this.s.show.finalists.includes(pk)) throw new GameError("Only the three finalists throw pirates");
    if (this.s.phase === "paused") throw new GameError("The game is paused");
    if (this.s.phase !== "open") throw new GameError("Wait for the final to start");
    const thrown = this.s.pirates.filter((x) => x.from === pk);
    if (thrown.length >= PIRATES_EACH) throw new GameError("You're out of pirates");
    const rivals = this.s.show.finalists.filter((x) => x !== pk && this.s.players[x] && !thrown.some((t) => t.to === x));
    if (!rivals.length) throw new GameError("Nobody left to throw a pirate at");
    // it flies at whichever rival ship is nearest right now
    const c = this.cove;
    const t = this.now() / 1000;
    const me = shipAt(pl.slot, t, c);
    const dist = (x: string) => {
      const o = shipAt(this.s.players[x].slot, t, c);
      return Math.hypot(o.x - me.x, o.y - me.y);
    };
    rivals.sort((a, b) => dist(a) - dist(b));
    const to = rivals[0];
    this.s.pirates.push({ id: ++this.s.seq, at: this.now(), from: pk, to });
    this.changed();
    return { ok: true, message: `pirate: ${JSON.stringify({ to, name: this.s.players[to].name, left: PIRATES_EACH - thrown.length - 1 })}` };
  }

  /**
   * A winner of the final sends their Lightning address so the host can pay them. Only players
   * with a share of the treasure can; the address goes to the host page, never to the public state.
   */
  claimPrize(pk: string, raw: string): Result {
    const f = this.s.final;
    if (this.s.phase !== "final" || f?.stage !== "final") throw new GameError("Prizes are claimed when the final is over");
    const mine = f.ranking.find((r) => r.pk === pk);
    if (!mine || mine.share <= 0) throw new GameError("Only the final's winners claim a prize");
    const address = String(raw ?? "").trim().toLowerCase().slice(0, 120);
    if (!/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(address)) throw new GameError("That doesn't look like a Lightning address (like you@walletofsatoshi.com)");
    const prev = this.s.show.payouts?.[pk];
    if (prev && (prev.status === "paid" || prev.status === "paying")) throw new GameError(prev.status === "paid" ? "Your prize is already paid!" : "Your prize is on its way…");
    (this.s.show.payouts ??= {})[pk] = { address, sats: mine.share, status: "waiting" };
    this.changed();
    this.onClaim?.(pk);
    return { ok: true, message: "prize: sent to the host" };
  }

  /**
   * The winner would rather scan a QR with their wallet (LNURL-withdraw). Returns the one-time
   * code for it; a new code replaces the old one until the prize is paid.
   */
  prizeQr(pk: string): string {
    const f = this.s.final;
    if (this.s.phase !== "final" || f?.stage !== "final") throw new GameError("Prizes are claimed when the final is over");
    const mine = f.ranking.find((r) => r.pk === pk);
    if (!mine || mine.share <= 0) throw new GameError("Only the final's winners claim a prize");
    const prev = this.s.show.payouts?.[pk];
    if (prev && (prev.status === "paid" || prev.status === "paying")) throw new GameError(prev.status === "paid" ? "Your prize is already paid!" : "Your prize is on its way…");
    const token = randomBytes(16).toString("hex");
    (this.s.show.payouts ??= {})[pk] = { address: "scan to receive (QR)", token, sats: mine.share, status: "waiting" };
    this.changed();
    return token;
  }

  /** Whose prize a scan-to-receive code is for (only while it's waiting to be paid). */
  prizeByToken(token: string) {
    for (const [pk, p] of Object.entries(this.s.show.payouts ?? {})) if (p.token && p.token === token) return { pk, p };
    return null;
  }

  /** Hooks for the server: a round ended, a winner sent their address. */
  onFinish?: (f: FinalInfo) => void;
  onClaim?: (pk: string) => void;

  /** Record how a payout went (the wallet works in the background). */
  setPayout(pk: string, patch: Partial<Payout>) {
    const p = this.s.show.payouts?.[pk];
    if (!p) return;
    Object.assign(p, patch);
    if (patch.status !== "failed") delete p.error;
    this.changed();
  }

  /** A Nostr badge was awarded: remember it so the winner can brag about it. */
  giveBadge(pk: string, id: string) {
    const list = ((this.s.show.badges ??= {})[pk] ??= []);
    if (!list.includes(id)) list.push(id);
    this.changed();
  }

  hideFeed(id: number, hidden = true) {
    const f = this.s.feed.find((x) => x.id === id);
    if (!f) throw new GameError("No such guess");
    f.hidden = hidden;
    this.changed();
  }

  private dropRandomTile() {
    const up = this.s.fallen.map((f, i) => (f === false && !this.s.cracking[i] ? i : -1)).filter((i) => i >= 0);
    if (!up.length) return;
    this.s.fallen[up[Math.floor(this.random() * up.length)]] = null;
  }

  /** A letter nobody can see yet, in a word nobody has found. A word always keeps one blank. */
  private pickLetter(): [number, number] | null {
    const options: [number, number][] = [];
    this.words.forEach((w, i) => {
      if (w.given || this.s.found[i]) return;
      const promised = this.s.letterPeeks.filter((x) => x.word === i).map((x) => x.pos);
      const blank = [...w.text].map((_, k) => k).filter((k) => !(k in this.s.letters[i]) && !promised.includes(k));
      if (blank.length > 1) for (const k of blank) options.push([i, k]);
    });
    if (!options.length) return null;
    return options[Math.floor(this.random() * options.length)];
  }

  /** One more letter appears by itself. */
  private revealRandomLetter(): boolean {
    const pick = this.pickLetter();
    if (!pick) return false;
    const [i, k] = pick;
    this.s.letters[i][k] = this.words[i].text[k];
    return true;
  }

  private addFeed(f: Omit<FeedItem, "id" | "at">) {
    this.s.feed.push({ ...f, id: ++this.s.seq, at: this.now() });
    if (this.s.feed.length > MAX_FEED) this.s.feed.splice(0, this.s.feed.length - MAX_FEED);
  }

  // ───────────── what pages see ─────────────

  /** The file for a tile: once it has fallen, during its shooter's peek, or after the game. */
  tileFile(gameId: string, file: string): string | null {
    if (gameId !== this.s.gameId) return null;
    const dir = join(this.opts.dataDir, "games", gameId);
    if (file === `${this.s.fullToken}.jpg`) return this.s.phase === "final" ? join(dir, file) : null;
    if (this.s.revealToken && file === `${this.s.revealToken}.jpg`) return this.s.final?.revealUrl ? join(dir, file) : null;
    const peek = file.endsWith(".webp") ? this.s.peeks[file.slice(0, -5)] : undefined;
    if (peek !== undefined) return join(dir, `${this.s.tiles[peek].token}.webp`);
    const i = this.s.tiles.findIndex((t) => `${t.token}.webp` === file);
    if (i < 0) return null;
    return this.s.fallen[i] !== false || this.s.phase === "final" ? join(dir, file) : null;
  }

  publicState(): PubState {
    const s = this.s;
    const over = s.phase === "final";
    const topMiss = Object.entries(s.missCounts).sort((a, b) => b[1] - a[1])[0];
    return {
      v: s.v,
      now: this.now(),
      phase: s.phase,
      settings: s.settings,
      gameId: s.gameId,
      // The title often gives the answer away, so it's only shown at the end.
      puzzleTitle: over ? this.puzzle.title : "",
      commitment: s.commitment,
      image: s.image,
      words: this.words.map((w, i) => {
        const f = s.found[i];
        const shown = w.given || f || over;
        return {
          given: w.given,
          len: w.text.length,
          letters: shown ? {} : s.letters[i],
          ...(shown ? { text: w.text } : {}),
          ...(f ? { foundBy: f.pk, points: f.points } : {}),
        };
      }),
      tiles: s.tiles.map((t, i) => ({
        points: t.points.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(" "),
        ...(s.fallen[i] !== false || over ? { img: { url: `/tile/${s.gameId}/${t.token}.webp`, x: t.x, y: t.y, w: t.w, h: t.h } } : {}),
        ...(typeof s.fallen[i] === "string" ? { by: s.fallen[i] as string } : {}),
      })),
      clues: this.puzzle.clues.slice(0, s.cluesOut),
      cluesTotal: this.puzzle.clues.length,
      players: Object.fromEntries(
        Object.entries(s.players).map(([k, p]) => [
          k,
          { name: p.name, slot: p.slot, points: p.points, shots: p.shots, hits: p.hits, ...(p.picture ? { picture: p.picture } : {}), ...(p.npub ? { npub: p.npub } : {}), ...(p.bot ? { bot: true } : {}) },
        ]),
      ),
      deadline: s.deadline,
      ...(s.paused ? { paused: { remaining: Math.max(0, s.deadline - s.paused.at) } } : {}),
      feed: s.feed,
      shots: s.shots,
      cracking: s.cracking,
      locks: s.locks,
      wind: s.wind,
      misses: s.misses,
      ...(topMiss ? { topMiss: { text: topMiss[0], n: topMiss[1] } } : {}),
      ...(s.final ? { final: s.final } : {}),
      show: { stage: s.show.stage, round: s.show.round, totals: s.show.totals, finalists: s.show.finalists, eliminated: s.show.eliminated, prelimLeft: this.prelimLeft(), prelimTotal: this.puzzles.filter((p) => !p.finalOnly).length },
      ...(s.phase === "kraken" && s.kraken ? { kraken: s.kraken } : {}),
      rules: { autoLetters: this.puzzle.autoLetters !== false, kraken: this.puzzle.kraken !== false, wordPoints: this.puzzle.points ?? null },
      letterPeeks: s.letterPeeks,
      targetBackAt: s.targetBackAt,
      pirates: s.pirates,
      ...(this.puzzle.hint ? { hint: this.puzzle.hint } : {}),
      autoPay: this.autoPay,
      claimed: Object.entries(s.show.payouts ?? {}).filter(([, p]) => !p.token || p.status !== "waiting").map(([pk]) => pk),
      paid: Object.entries(s.show.payouts ?? {}).filter(([, p]) => p.status === "paid").map(([pk]) => pk),
      badges: s.show.badges ?? {},
      mode: this.heightMode ? "height" : "phrase",
      tipHeight: this.tipHeight,
      goAt: s.goAt ?? 0,
      locked: Object.keys(s.locked ?? {}),
    };
  }

  /** Host-only view: the answer and clues. */
  secrets() {
    return {
      answer: this.words.map((w) => (w.given ? w.text.toLowerCase() : w.text)).join(" "),
      aka: this.puzzle.aka,
      clues: this.puzzle.clues,
      imagePrompt: this.puzzle.imagePrompt,
      puzzles: this.puzzles.map((p) => ({ id: p.id, title: p.title, hasImage: !!findImage(this.opts.imagesDir, p.id), ...(p.finalOnly ? { finalOnly: true } : {}) })),
      puzzleId: this.puzzle.id,
      // the final's winners, their prize and (once sent) their Lightning address
      payouts: this.s.final?.stage === "final" ? this.s.final.ranking.filter((r) => r.share > 0).map((r) => ({ pk: r.pk, name: this.s.players[r.pk]?.name ?? "?", sats: r.share, address: this.s.show.payouts?.[r.pk]?.address ?? null, status: this.s.show.payouts?.[r.pk]?.status ?? null, error: this.s.show.payouts?.[r.pk]?.error ?? null })) : [],
    };
  }
}

export function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function cleanName(s: string) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}
function num<T>(o: T, k: keyof T, lo: number, hi: number) {
  (o as Record<string, unknown>)[k as string] = clamp(Math.round(Number(o[k])), lo, hi);
}
