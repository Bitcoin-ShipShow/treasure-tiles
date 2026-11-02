// NIP-58 badges from the show's own Nostr key, the same way Whose Zap does it: a badge
// definition (kind 30009) for each title, and an award (kind 8) naming the winner. They go to
// a few public relays, so the badge turns up on the winner's profile. Only players who signed in
// with their real Nostr key can get one.

import WebSocket from "ws";
import { finalizeEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BADGE_RELAYS = (process.env.BADGE_RELAYS ?? "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net").split(",").map((s) => s.trim()).filter(Boolean);

export const BADGES = {
  round: { d: "treasuretiles-round", name: "Treasure Tiles Sharpshooter", description: "Won a round of Treasure Tiles on the Bitcoin Shipshow: closest and quickest to the block height.", image: "eyepatch.png" },
  // the belt passes from champion to champion: a new award deletes the last one
  champion: { d: "shipshow-belt", name: "Bitcoin Ship Show Hardcore Championship Belt", description: "Held by the reigning champion of the Bitcoin Shipshow's game night. Won it? Defend it next month.", image: "belt.png" },
} as const;
export type BadgeId = keyof typeof BADGES;

export class Badges {
  constructor(
    private sk: Uint8Array,
    private pubkey: string,
    /** Where the badge pictures live (a permanent address: the public repo, or this server). */
    private imageBase: string,
    private dataDir: string,
  ) {}

  private sign(t: EventTemplate) {
    return finalizeEvent(t, this.sk);
  }

  /** Publish (or refresh) the badge definitions. Images need a public https address. */
  async define() {
    for (const b of Object.values(BADGES)) {
      const tags = [["d", b.d], ["name", b.name], ["description", b.description]];
      if (this.imageBase.startsWith("https://")) tags.push(["image", `${this.imageBase}/${b.image}`, "512x512"], ["thumb", `${this.imageBase}/${b.image}`, "512x512"]);
      await publish(this.sign({ kind: 30009, created_at: Math.floor(Date.now() / 1000), tags, content: "" }));
    }
  }

  async award(id: BadgeId, to: string, note: string) {
    const b = BADGES[id];
    const ev = this.sign({ kind: 8, created_at: Math.floor(Date.now() / 1000), tags: [["a", `30009:${this.pubkey}:${b.d}`], ["p", to]], content: note });
    await publish(ev);
    if (id !== "champion") return;
    // the belt moves on: ask relays and apps to drop the previous holder's award (NIP-09)
    const file = join(this.dataDir, "belt-holder.json");
    const prev = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { id: string; to: string }) : null;
    writeFileSync(file, JSON.stringify({ id: ev.id, to }));
    if (prev && prev.id !== ev.id && prev.to !== to) {
      await publish(this.sign({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [["e", prev.id], ["k", "8"]], content: "The belt has a new champion." }));
    }
  }
}

/** Fire and forget to each relay; a slow or dead relay must never hold up the game. */
export async function publish(ev: Event) {
  await Promise.all(BADGE_RELAYS.map((url) => send(url, ev)));
}

function send(url: string, ev: Event): Promise<void> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve();
    };
    const timer = setTimeout(done, 6000);
    try {
      ws = new WebSocket(url, { headers: { "User-Agent": "treasure-tiles/0.1" } });
    } catch {
      return done();
    }
    ws.on("error", done);
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", ev])));
    ws.on("message", (d) => {
      try {
        if (JSON.parse(String(d))[0] === "OK") done();
      } catch {
        /* ignore */
      }
    });
  });
}
