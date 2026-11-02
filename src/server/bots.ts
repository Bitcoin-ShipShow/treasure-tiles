// Pretend players for rehearsals and screenshots. They fire wobbly shots at the cliff (plenty
// fall short) and now and then guess, mostly wrong.

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Game } from "./game.ts";

const NAMES = ["Salty Pete", "Anne Bonnie", "Hashbeard", "Captain Lowfee", "Mutiny Mo", "Peg-Leg Satoshi", "Barnacle Bill", "Two-Key Tina", "Cold Storage Carl", "Relay Rita", "Lady Lightning", "Dusty Doubloon", "Gale Force Gus", "Inky Ines", "Bosun Boop"];
const JUNK = ["llama", "parrot", "treasure", "rum", "cannon", "anchor", "shark", "laser", "moon", "hodl", "whale", "pizza", "kraken", "node", "cat", "monkey", "storm", "dog"];

export class Bots {
  private keys: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private game: Game) {
    this.keys = Object.entries(game.s.players).filter(([, p]) => p.bot).map(([k]) => k);
  }

  get count() {
    return this.keys.filter((k) => this.game.s.players[k]).length;
  }

  add(n: number) {
    for (let i = 0; i < n; i++) {
      const pk = getPublicKey(generateSecretKey());
      const taken = new Set(Object.values(this.game.s.players).map((p) => p.name));
      const name = NAMES.find((x) => !taken.has(x)) ?? `Deckhand ${this.keys.length + 1}`;
      this.game.join(pk, name, { bot: true });
      // every third bot shows a picture on its mainsail, like a player with a Nostr profile picture
      if (this.keys.length % 3 === 0) this.game.s.players[pk].picture = "/brand/shipshow-boat.png";
      this.keys.push(pk);
    }
    this.run();
  }

  clear() {
    for (const k of this.keys) if (this.game.s.players[k]) this.game.removePlayer(k);
    this.keys = [];
  }

  run() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), 700);
    this.timer.unref();
  }

  private step() {
    const g = this.game;
    if (g.phase !== "open") return;
    for (const pk of this.keys) {
      if (!g.s.players[pk]) continue;
      try {
        if (Math.random() < 0.35) g.fire(pk, (Math.random() - 0.5) * 60, 0.15 + Math.random() * 0.85);
        // block-height rounds: lock in a guess within a few years of the answer, sooner or later
        if (g.heightMode) {
          if (!g.s.locked[pk] && Math.random() < 0.06) {
            const answer = g.puzzleInfo.height!;
            g.lockHeight(pk, Math.max(0, Math.round(answer + (Math.random() - 0.5) * 2 * 52_560 * 2.5)));
          }
          continue;
        }
        if (Math.random() < 0.05) {
          const open = g.hiddenWords.filter((w) => !g.s.found[w.i]);
          const word = Math.random() < 0.2 && open.length ? open[Math.floor(Math.random() * open.length)].text : JUNK[Math.floor(Math.random() * JUNK.length)];
          g.guess(pk, word.toLowerCase());
        }
      } catch {
        /* reloading or waiting out a wrong guess: fine */
      }
    }
  }
}
