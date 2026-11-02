// What the server tells every page, and what pages send back. Everything here is public:
// the answer, the clue list and unrevealed tiles never appear in these shapes.

/**
 * Nostr event kinds this game uses. They are the game's own, not standard kinds. Players'
 * actions use the "ephemeral" range (20000-29999): relays pass those along and never store
 * them, and they are only ever sent to the game's own relay, so guesses never land in
 * anyone's Nostr feed.
 */
export const KIND = {
  join: 25900, // device key: { name } -> join (or rename)
  guess: 25901, // device key: { text }
  link: 25903, // the player's real Nostr key, tag ["p", devicePubkey]: "this device plays as me"
  fire: 25904, // device key: { angle, power } -> a cannon shot
  pirate: 25905, // device key: {} -> launch a pirate at another finalist's ship (the final only)
  prize: 25906, // device key: { address } -> a final winner's Lightning address, for the host only
  height: 25907, // device key: { height } -> lock in a block-height guess (one per round)
  state: 30910, // show key, d=state: the public game state (addressable, the relay keeps the latest)
} as const;

export type Phase = "lobby" | "open" | "kraken" | "paused" | "final";
export type Stage = "prelim" | "final";

/** The whole show: quick prelim rounds (points add up), then a final for the top 3. */
export interface ShowInfo {
  stage: Stage;
  /** Prelim round number (1, 2, 3…); the final keeps the last number. */
  round: number;
  /** Points from finished prelim rounds. */
  totals: Record<string, number>;
  /** The three players in the final. */
  finalists: string[];
  /** Dragged under by the kraken: they watch the rest of the show. */
  eliminated: string[];
  /** Prelim rounds not played yet (0: the next one is the final). */
  prelimLeft?: number;
  /** How many rounds the show has. */
  prelimTotal?: number;
}

/** The kraken lottery: the bottom third are spun, half are dragged to the bottom of the sea. */
export interface KrakenInfo {
  /** When it started and when play resumes (server ms). */
  at: number;
  until: number;
  /** In the lottery, in spin order. */
  candidates: string[];
  /** Chosen to be dragged under. */
  doomed: string[];
  /** true: the names spin first; false: the kraken simply takes the bottom of the board. */
  lottery: boolean;
}

export interface Settings {
  title: string;
  tagline: string;
  /** Length of a prelim round. */
  gameSeconds: number;
  /** Length of the final (top 3 only). */
  finalSeconds: number;
  /** Points for knocking a slab off with your cannon. */
  hitPoints: number;
  /** The kraken lottery happens this many seconds into each of the first rounds… */
  krakenAfterSeconds: number;
  /** …in this many prelim rounds (0 = never)… */
  krakenRounds: number;
  /** …if at least this many players are still in the show. */
  krakenMinPlayers: number;
  /** About how many tiles (rock slabs) cover the picture. */
  tiles: number;
  /** Seconds to reload your cannon between shots. */
  reloadSeconds: number;
  /** A tile you knock off is shown only to you for this long, then to everyone. */
  peekSeconds: number;
  /** After someone hits the letter target, it rests this long (0 = shoot it again right away). */
  targetCooldownSeconds: number;
  /** After a wrong guess you wait this long (stops machine-gun guessing). */
  lockoutSeconds: number;
  /** A tile falls by itself this often (0 = never). */
  tileEverySeconds: number;
  /** A letter appears by itself this often (0 = never). */
  letterEverySeconds: number;
  /** Letters shown from the start wherever they appear in hidden words. */
  freeLetters: string;
  /** A written clue is released to everyone this often (0 = never). */
  clueEverySeconds: number;
  /** Extra points for completing the phrase. */
  solveBonus: number;
  /** Practice sats for the winners. */
  prizePool: number;
  /** "points": treasure split in proportion to points. "winner": top scorer takes it all. */
  prizeSplit: "points" | "winner";
  /** A 3-2-1 countdown before each round (seconds; 0 = none). Nobody can fire or guess during it. */
  countdownSeconds: number;
  /** Block-height rounds: this many slabs per player (20–100 in all); 0 = use `tiles`. */
  tilesPerPlayer: number;
  /** Share of the slabs already off the wall when a round starts (0–0.5). */
  preFallen: number;
  /** Block-height rounds: points for an exact guess locked in at once. */
  maxPoints: number;
  /** Block-height rounds: a guess this many years off (or more) scores nothing. */
  zeroYears: number;
}

export const DEFAULT_SETTINGS: Settings = {
  title: "Treasure Tiles",
  tagline: "Shoot the wall. Guess the block height. Win the treasure.",
  gameSeconds: 45,
  finalSeconds: 45,
  hitPoints: 2,
  krakenAfterSeconds: 15,
  krakenRounds: 0,
  krakenMinPlayers: 7,
  tiles: 48,
  reloadSeconds: 1,
  peekSeconds: 5,
  targetCooldownSeconds: 0,
  lockoutSeconds: 4,
  tileEverySeconds: 0,
  letterEverySeconds: 8,
  freeLetters: "SHIPSHOW",
  clueEverySeconds: 15,
  solveBonus: 10,
  prizePool: 10_000,
  prizeSplit: "winner",
  countdownSeconds: 3,
  tilesPerPlayer: 4,
  preFallen: 0,
  maxPoints: 100,
  zeroYears: 3,
};

/** One word of the phrase as the public sees it. */
export interface PubWord {
  /** Given words (a, the, of…) are shown from the start and score nothing. */
  given: boolean;
  /** Set once the word is found (or always, for given words). */
  text?: string;
  len: number;
  /** Letters showing so far, by position. */
  letters: Record<number, string>;
  foundBy?: string; // player pubkey
  points?: number;
}

export interface PubTile {
  /** Polygon in picture pixels, "x,y x,y …". */
  points: string;
  /** Present once the tile has fallen. */
  img?: { url: string; x: number; y: number; w: number; h: number };
  by?: string; // pubkey of whoever knocked it off; absent for tiles that fell by themselves
}

export interface PubPlayer {
  name: string;
  /** Which ship in the fleet (sets its course around the cove). */
  slot: number;
  picture?: string;
  npub?: string;
  points: number;
  shots: number;
  hits: number;
  bot?: boolean;
}

export interface FeedItem {
  id: number;
  at: number;
  pk: string;
  kind: "hit" | "miss" | "solve" | "clue";
  /** What they typed (or the clue). */
  text: string;
  words?: string[];
  points?: number;
  hidden?: boolean;
}

/** A cannon shot, in cove coordinates (see shared/cannon.ts). */
export interface Shot {
  id: number;
  at: number;
  pk: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  result: "hit" | "letter" | "rubble" | "rock" | "town" | "short" | "over" | "wide";
  tile: number;
  /** Fired between rounds: it bounces off the slabs and doesn't count. */
  practice?: boolean;
}

export interface FinalInfo {
  reason: "solved" | "time" | "host" | "all";
  /** A prelim round only adds to the show totals; the final pays out the treasure. */
  stage: Stage;
  /** Everyone who scored, best first, with their share of the treasure. */
  ranking: { pk: string; points: number; share: number }[];
  solvedBy?: string;
  answer: string;
  salt: string;
  imageUrl: string;
  /** The finished picture (the title written on it), swapped onto the cliff when someone solves it. */
  revealUrl?: string;
  /** Block-height rounds: the answer, when it happened, and everyone's locked-in guess. */
  height?: number;
  when?: string;
  event?: string;
  guesses?: { pk: string; height: number; off: number; points: number }[];
  /** The last round of the show: the ranking is the show total and the treasure is paid. */
  showOver?: boolean;
}

/** The final only: each finalist may throw one silly pirate, at the nearest rival ship. */
export const PIRATES_EACH = 1;
/** How long a pirate flies (ms), then how long it stays splatted on the victim's screen. */
export const PIRATE_FLIGHT_MS = 1400;
export const PIRATE_SPLAT_MS = 5000;
export interface Pirate {
  id: number;
  /** Launched at (server ms); it lands PIRATE_FLIGHT_MS later. */
  at: number;
  from: string;
  to: string;
}

export interface PubState {
  v: number;
  now: number;
  phase: Phase;
  settings: Settings;
  gameId: string;
  puzzleTitle: string;
  /** sha256(salt + "|" + answer), published before play so nobody can swap the answer later. */
  commitment: string;
  image: { w: number; h: number };
  words: PubWord[];
  tiles: PubTile[];
  clues: string[];
  cluesTotal: number;
  players: Record<string, PubPlayer>;
  deadline: number;
  paused?: { remaining: number };
  feed: FeedItem[];
  shots: Shot[];
  /** Tiles that were just hit, seen only by the shooter until they fall. */
  cracking: Record<number, { pk: string; until: number }>;
  /** Players waiting out a wrong guess, and until when. */
  locks: Record<string, number>;
  /** -1..1: pushes cannonballs left or right. */
  wind: number;
  misses: number;
  topMiss?: { text: string; n: number };
  final?: FinalInfo;
  show: ShowInfo;
  kraken?: KrakenInfo;
  /** This round's own rules. */
  rules: { autoLetters: boolean; kraken: boolean; wordPoints: number | null };
  /** Letters won at the letter target, seen only by the shooter until `until`. */
  letterPeeks: { pk: string; word: number; pos: number; until: number }[];
  /** The letter target rests after a hit until this time (server ms). */
  targetBackAt: number;
  /** Pirates thrown this round (the final only). */
  pirates: Pirate[];
  /** A nudge shown beside "Secret phrase", e.g. "it's a number". */
  hint?: string;
  /** Winners who have sent the host their Lightning address (the addresses stay private). */
  claimed?: string[];
  /** Winners whose prize the game's wallet has paid. */
  paid?: string[];
  /** Nostr badges won this show, by player (only players signed in with Nostr). */
  badges?: Record<string, string[]>;
  /** "height": guess the block height of the event in the picture. "phrase": the old word puzzle. */
  mode: "height" | "phrase";
  /** When the round's countdown ends and the cannons may fire (server ms). */
  goAt: number;
  /** The current Bitcoin block height (the top of the guess dial). */
  tipHeight: number;
  /** Who has locked in a guess this round (not what they guessed: that stays secret till the end). */
  locked: string[];
}
