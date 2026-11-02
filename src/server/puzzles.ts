import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The puzzle bank. Each puzzle is one long, absurd phrase plus a literal picture of it.
//
// How to write one:
//  - phrase: CAPITAL words are hidden and score points; lowercase words (a, the, of…) are
//    shown from the start. Letters and digits only inside a word.
//  - aka: other words a fair person would type for a hidden word after looking at the
//    picture (BIGFOOT for SASQUATCH). The board always shows the official word. Plurals and
//    "multi-sig" vs "multisig" are handled automatically; don't list those.
//  - clues: released (or bought) in this order. Hints, not giveaways.
//  - start: the part of the picture uncovered from the start, as fractions [left, top,
//    right, bottom]. Make it the funny setup; keep the punchline covered. The image prompt
//    says where things go so the picture matches.
//  - image: put the picture in puzzles/images/<id>.png (or .jpg / .webp). Until it exists
//    the game draws a labelled placeholder so you can rehearse.

export interface Puzzle {
  id: string;
  title: string;
  phrase: string;
  aka: Record<string, string[]>;
  clues: string[];
  imagePrompt: string;
  /**
   * The part of the picture that's uncovered from the start: the funny setup. Fractions of
   * the width and height: [left, top, right, bottom]. The punchline stays hidden.
   */
  start?: [number, number, number, number];
  /**
   * The opposite of `start`: only this part starts covered and everything around it is
   * uncovered (e.g. show just the outer edge of the picture).
   */
  hide?: [number, number, number, number];
  /** Points for each hidden word (default: its number of letters). */
  points?: number;
  /** Letters appear by themselves over time (default true). */
  autoLetters?: boolean;
  /**
   * The kraken in this round: false = it sleeps; or how it strikes. Default (true): the
   * host's timing, the bottom third into a lottery, half dragged under.
   */
  kraken?: boolean | { afterSeconds?: number; /** take this share of the boats, lowest scores first, no lottery */ bottomShare?: number };
  /** About how many slabs cover the picture in this round (default: the host's setting). */
  tiles?: number;
  /** Block-height rounds: the answer (the block being mined when it happened)… */
  height?: number;
  /** …and when it happened (ISO, UTC). */
  when?: string;
  /** "When Laszlo bought two pizzas": the event, said at the end of the round. */
  event?: string;
  /** A nudge shown to everyone beside "Secret phrase" (e.g. "it's a number"). */
  hint?: string;
  /** Kept for the final: never picked as a prelim round. */
  finalOnly?: boolean;
  /** A straight slab line at this height (0..1), e.g. just under an uncovered first line. */
  seam?: number;
  /** This round's own pace (each falls back to the host's setting). */
  timing?: {
    roundSeconds?: number;
    tileEverySeconds?: number;
    firstLetterSeconds?: number;
    letterEverySeconds?: number;
    clueEverySeconds?: number;
  };
}

const STYLE =
  "Bold, funny storybook illustration with clear shapes and bright colors, every item large and easy to recognise, plain background, 4:3 landscape. No text or lettering anywhere except where stated.";

// The show's rounds live in a private file next to the pictures, so the answers never sit in
// the public code: puzzles/show.json (or PUZZLES_FILE). Without it, the made-up example rounds.
// Each: { id, title, height, when (ISO, UTC), event ("When …"), finalOnly? }; the picture is
// puzzles/images/<id>.png|jpg|webp.
const here = dirname(fileURLToPath(import.meta.url));
function loadShow(): Puzzle[] {
  const file = process.env.PUZZLES_FILE ? resolve(process.env.PUZZLES_FILE) : [join(here, "../../puzzles/show.json"), join(here, "../../puzzles/show.example.json")].find(existsSync)!;
  const rounds = JSON.parse(readFileSync(file, "utf8")) as { id: string; title: string; height: number; when: string; event: string; finalOnly?: boolean }[];
  return rounds.map((r) => ({ ...heightRound(r.id, r.title, r.height, r.when, r.event), ...(r.finalOnly ? { finalOnly: true } : {}) }));
}
export const PUZZLES: Puzzle[] = loadShow();

/** A block-height round: the picture is the clue; the answer is a number. */
export function heightRound(id: string, title: string, height: number, when: string, event: string): Puzzle {
  return { id, title, phrase: String(height), aka: {}, clues: [], imagePrompt: "Your own picture of the event.", height, when, event };
}

export const SPARE_PUZZLES: Puzzle[] = [
  {
    // Round 2: only the outer edge of the picture shows at first; Bitty and the rest are covered.
    id: "bitty",
    title: "Coffee Break",
    phrase: "BITTY makes COFFEE at ANTIDOTE", // "makes" is filled in from the start
    aka: {
      BITTY: ["bittie", "bitties"],
      COFFEE: ["joe"],
      ANTIDOTE: [],
    },
    clues: [
      "The orange, furry face of Bitcoin.",
      "Something you pour into a mug.",
      "Where you'd go to cure what ails you, if it were an office.",
    ],
    imagePrompt: "Your own picture: Bitty pouring coffee in an office kitchen.",
    hide: [0.06, 0.07, 0.94, 0.93],
    tiles: 100,
    kraken: { afterSeconds: 20, bottomShare: 1 / 6 },
  },
  {
    // Round 3: only the first line ("On Saturday night") shows; the rest of the verse and the
    // script are covered. Small slabs so a slab edge falls just under that first line.
    id: "lacrypta",
    title: "Saturday Night Script",
    phrase: "on saturday night i went to LA CRYPTA they taught me to write BITCOIN SCRIPT -a",
    aka: {
      LA: [],
      CRYPTA: [],
      BITCOIN: ["btc"],
      SCRIPT: ["scripta"],
    },
    clues: [
      "A Bitcoin hacker space in Buenos Aires.",
      "OP_DUP, OP_HASH160, OP_CHECKSIG: what language is that?",
      "It rhymes with the place you went on Saturday night.",
    ],
    imagePrompt: "Your own picture: the La Crypta verse over a Bitcoin script code block.",
    start: [0, 0, 1, 0.185],
    seam: 0.185, // a straight line in the thin gap between the verse's first and second lines
    tiles: 36, // big slabs: the verse is big text
  },
  {
    // The final. The cliff shows the picture without its title; once someone solves it,
    // the titled version (puzzles/images/brains-reveal.png) takes its place: the glorious reveal.
    id: "brains",
    title: "A Storm of Brains",
    phrase: "a STORM of BRAINS",
    aka: { STORM: ["tempest"], BRAINS: ["brain"] },
    clues: [
      "Book three of a famous fantasy saga, but smarter.",
      "What a team does at a whiteboard, turned inside out.",
      "Who sits on the throne? Something pink and squishy.",
    ],
    imagePrompt: "Your own picture: a crowned brain on a throne of swords, in a lightning storm.",
    finalOnly: true,
  },

  {
    id: "saylor",
    title: "Bear Market",
    phrase: "MICHAEL SAYLOR SCREAMING because a BEAR is BITING his FOOT",
    aka: {
      MICHAEL: ["mike"],
      SAYLOR: ["sailor"],
      SCREAMING: ["screams", "yelling", "yells", "shouting", "howling", "crying", "wailing", "shrieking"],
      BEAR: ["grizzly"],
      BITING: ["bites", "chewing", "chews", "chomping", "eating", "gnawing"],
      FOOT: ["toe", "toes", "feet"],
    },
    clues: [
      "He has never sold. Not once.",
      "The kind of market he says doesn't scare him.",
      "Ten little piggies, one of them in trouble.",
    ],
    imagePrompt: `A cartoon caricature of a bald businessman in a suit (Michael Saylor style) screaming in pain, arms flailing, one bare foot kicked out to the right. LEFT 40% of the picture: him. RIGHT 60%: a big brown grizzly bear chomping on his bare foot. ${STYLE}`,
    start: [0, 0, 0.44, 1],
  },
  {
    id: "sasquatch",
    title: "The Reading Sasquatch",
    phrase: "ORANGE SASQUATCH WEARING ALPACA SOCKS READING BITCOIN MAGAZINE",
    aka: {
      ORANGE: ["ginger"],
      SASQUATCH: ["bigfoot", "big foot", "yeti"],
      WEARING: ["wears"],
      ALPACA: [],
      SOCKS: ["stockings"],
      READING: ["reads"],
      BITCOIN: ["btc"],
      MAGAZINE: ["mag", "zine"],
    },
    clues: [
      "Nobody has ever taken a sharp photo of him.",
      "The yarn came from the Andes, not from a sheep.",
      "The print one, with the cover price in sats.",
    ],
    imagePrompt: `A huge orange-furred sasquatch sitting in an armchair in a forest. TOP-LEFT: his big hairy face, looking relaxed. TOP-RIGHT and middle: a glossy magazine in his hands whose cover clearly says "BITCOIN MAGAZINE". BOTTOM: his huge feet in chunky striped alpaca-wool socks. ${STYLE}`,
    start: [0, 0, 0.5, 0.55],
  },
  {
    id: "grandma",
    title: "Grandma's Hashrate",
    phrase: "GRANDMA MINING BITCOIN with a TOASTER during a THUNDERSTORM",
    aka: {
      GRANDMA: ["granny", "grandmother", "nana", "gran", "grandmom", "granma"],
      MINING: ["mines", "mine"],
      BITCOIN: ["btc"],
      TOASTER: [],
      THUNDERSTORM: ["storm", "lightning storm", "thunder"],
    },
    clues: [
      "She knits, she bakes, and she has a hashrate.",
      "A breakfast appliance, now a space heater that earns.",
      "Free power from the sky, if she's brave enough.",
    ],
    imagePrompt: `A kitchen. LEFT HALF: a sweet grandmother in a cardigan and glasses grinning wildly, hair standing on end. RIGHT HALF: a smoking toaster wired to a laptop showing a big orange Bitcoin logo, and a window behind it with a wild thunderstorm and lightning. ${STYLE}`,
    start: [0, 0, 0.45, 1],
  },
  {
    id: "nostrich",
    title: "Beach Justice",
    phrase: "a NOSTRICH ZAPPING a SEAGULL who STOLE a HARDWARE WALLET",
    aka: {
      NOSTRICH: ["ostrich"],
      ZAPPING: ["zaps", "zap", "zapped"],
      SEAGULL: ["gull", "sea gull"],
      STOLE: ["stealing", "steals", "stolen", "swiped", "snatched", "nicked", "took", "grabbed"],
      HARDWARE: [],
      WALLET: [],
    },
    clues: [
      "The bird on the left is a protocol's purple mascot.",
      "Beach thief. Usually goes for your chips.",
      "Cold storage that fits in a pocket, or in a beak.",
    ],
    imagePrompt: `A sandy beach. LEFT THIRD: a furious purple-feathered ostrich (the Nostr "nostrich" mascot) firing a bright lightning bolt from its phone toward the right. RIGHT TWO-THIRDS: a smug seagull flying away with a small black hardware wallet in its beak. ${STYLE}`,
    start: [0, 0, 0.4, 1],
  },
  {
    id: "octopus",
    title: "Deep Sea Routing",
    phrase: "an OCTOPUS with LASER EYES RUNNING EIGHT LIGHTNING NODES on the OCEAN FLOOR",
    aka: {
      OCTOPUS: ["octopi", "octopuses"],
      LASER: ["lazer"],
      EYES: ["eye", "eyed"],
      RUNNING: ["runs", "operating", "operates", "hosting", "hosts"],
      EIGHT: ["8"],
      LIGHTNING: ["ln", "lightening"],
      NODES: ["servers"],
      OCEAN: ["sea"],
      FLOOR: ["bed", "bottom"],
    },
    clues: [
      "One computer per arm.",
      "Every Bitcoiner's profile picture had them in 2021.",
      "Very deep, very wet, very far from the power grid.",
    ],
    imagePrompt: `Underwater. TOP CENTER: the head of a cheerful purple octopus with glowing red laser beams shooting from its eyes. BOTTOM and SIDES: its eight arms each typing on a small glowing server box with a lightning-bolt symbol, resting on the sandy ocean floor with seaweed. ${STYLE}`,
    start: [0.25, 0, 0.75, 0.45],
  },
  {
    id: "ghost",
    title: "The Haunted Vault",
    phrase: "the GHOST of SATOSHI HAUNTING a BANK VAULT full of SHREDDED DOLLARS",
    aka: {
      GHOST: ["spirit", "phantom"],
      SATOSHI: ["nakamoto", "satoshi nakamoto"],
      HAUNTING: ["haunts", "haunted", "spooking", "scaring"],
      BANK: [],
      VAULT: ["safe"],
      SHREDDED: ["shredding", "shred"],
      DOLLARS: ["dollar", "cash", "money", "bills", "fiat", "usd"],
    },
    clues: [
      "He vanished in 2011 but never really left.",
      "Where old money sleeps behind a round steel door.",
      "What happens to paper after a few decades of printing.",
    ],
    imagePrompt: `CENTER-TOP: a friendly see-through ghost in a hoodie with an orange Bitcoin symbol on it, going "boo". AROUND IT and BELOW: the inside of a bank vault with a huge round open steel door on the right and heaps of shredded green dollar bills on the floor. ${STYLE}`,
    start: [0.3, 0, 0.7, 0.55],
  },
  {
    id: "queen",
    title: "Two of Three Parrots",
    phrase: "a PIRATE QUEEN SIGNING a MULTISIG TRANSACTION with THREE PARROTS",
    aka: {
      PIRATE: [],
      QUEEN: [],
      SIGNING: ["signs", "sign", "signed"],
      MULTISIG: ["multisignature"],
      TRANSACTION: ["tx", "txn"],
      THREE: ["3"],
      PARROTS: [],
    },
    clues: [
      "Royalty, but she earned the crown with a cutlass.",
      "Each bird holds a key; two of the three must agree.",
      "Moving coins from here to there, on-chain.",
    ],
    imagePrompt: `LEFT HALF: a fierce pirate queen with a crown and a cutlass at a captain's desk, signing a long scroll with a quill. RIGHT HALF: three colorful parrots each holding a golden key and pecking their own signature onto the same scroll. ${STYLE}`,
    start: [0, 0, 0.45, 1],
  },
  {
    id: "plank",
    title: "Off the Steel Plank",
    phrase: "a PIRATE CAPTAIN ENGRAVING his SEED PHRASE onto a STEEL PLANK",
    aka: {
      PIRATE: [],
      CAPTAIN: ["capt", "skipper"],
      ENGRAVING: ["engraves", "carving", "carves", "etching", "etches", "chiseling", "chiselling", "stamping", "stamps", "punching"],
      SEED: [],
      PHRASE: ["words", "mnemonic"],
      STEEL: ["metal"],
      PLANK: ["gangplank", "board"],
    },
    clues: [
      "Twelve or twenty-four words he should never say out loud.",
      "Fireproof, floodproof, and someone walks off the end of it.",
      "He's doing it with a hammer and a letter punch.",
    ],
    imagePrompt: `A ship's deck at sea. LEFT THIRD: a pirate captain with a tricorn hat kneeling, swinging a hammer. RIGHT TWO-THIRDS: a shiny steel plank sticking out over the sea like a gangplank, with twelve small numbered word-shaped marks punched into it (no readable words). ${STYLE}`,
    start: [0, 0, 0.35, 1],
  },
];

/** Every puzzle, show and spares (for tests). */
export const ALL_PUZZLES: Puzzle[] = [...PUZZLES, ...SPARE_PUZZLES];
