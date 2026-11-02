// The game's own small Nostr relay (NIP-01). Pages talk to the game only through it:
//  - players send signed action events (join, guess, buy, link); the relay checks the
//    signature, hands them to the game and answers with an OK message saying what happened;
//  - the show's signed state event is kept (latest only) and pushed to every subscriber.
// Player actions are ephemeral kinds: never stored, never forwarded to public relays.

import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilter, type Filter } from "nostr-tools/filter";
import { KIND } from "../shared/types.ts";

const MAX_EVENT_BYTES = 16 * 1024;
const ACTIONS_PER_SECOND = 5; // per connection; bursts of up to 8 (cannons fire about once a second)
const BURST = 8;
const ACTION_KINDS = new Set<number>([KIND.join, KIND.guess, KIND.link, KIND.fire, KIND.pirate, KIND.prize, KIND.height]);

export type ActionHandler = (ev: Event) => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string };

export class GameRelay {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private latest: Event | null = null;
  private subs = new Map<WebSocket, Map<string, Filter[]>>();
  private seen = new Map<string, number>(); // event id -> time, so a retried action runs once
  showPubkey = "";

  constructor(private handle: ActionHandler) {
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    setInterval(() => {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [id, t] of this.seen) if (t < cutoff) this.seen.delete(id);
    }, 60_000).unref();
  }

  get connections() {
    return this.subs.size;
  }

  /** The show publishes a new state event. */
  publish(ev: Event) {
    this.latest = ev;
    for (const [ws, subs] of this.subs) for (const [id, filters] of subs) if (filters.some((f) => matchFilter(f, ev))) this.send(ws, ["EVENT", id, ev]);
  }

  get state() {
    return this.latest;
  }

  /** Same checks for actions that arrive over plain HTTP (for networks that block websockets). */
  async submit(ev: Event): Promise<{ ok: boolean; message: string }> {
    const bad = this.check(ev);
    if (bad) return { ok: false, message: bad };
    if (this.seen.has(ev.id)) return { ok: true, message: "duplicate: already handled" };
    this.seen.set(ev.id, Date.now());
    return this.handle(ev);
  }

  private check(ev: Event): string | null {
    if (!ev || typeof ev !== "object" || typeof ev.id !== "string" || !Array.isArray(ev.tags)) return "invalid: bad event";
    if (JSON.stringify(ev).length > MAX_EVENT_BYTES) return "invalid: too large";
    if (!ACTION_KINDS.has(ev.kind)) return "blocked: this relay only takes this game's events";
    if (!verifyEvent(ev)) return "invalid: bad signature";
    const age = Math.abs(Date.now() / 1000 - ev.created_at);
    if (age > 600) return "invalid: clock is off by more than 10 minutes";
    return null;
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage) {
    this.subs.set(ws, new Map());
    let tokens = BURST;
    let at = Date.now();
    ws.on("close", () => this.subs.delete(ws));
    ws.on("error", () => {});
    ws.on("message", async (data) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(data));
      } catch {
        return this.send(ws, ["NOTICE", "invalid: not JSON"]);
      }
      if (!Array.isArray(msg)) return;
      const [type] = msg;
      if (type === "EVENT") {
        const ev = msg[1] as Event;
        tokens = Math.min(BURST, tokens + ((Date.now() - at) / 1000) * ACTIONS_PER_SECOND);
        at = Date.now();
        if (tokens < 1) return this.send(ws, ["OK", ev?.id ?? "", false, "rate-limited: slow down"]);
        tokens -= 1;
        let r: { ok: boolean; message: string };
        try {
          r = await this.submit(ev);
        } catch (e) {
          r = { ok: false, message: `error: ${(e as Error).message}` };
        }
        return this.send(ws, ["OK", ev?.id ?? "", r.ok, r.message]);
      }
      if (type === "REQ") {
        const [, subId, ...filters] = msg as [string, string, ...Filter[]];
        if (typeof subId !== "string" || subId.length > 64) return;
        const mine = this.subs.get(ws)!;
        if (!mine.has(subId) && mine.size >= 10) return this.send(ws, ["CLOSED", subId, "error: too many subscriptions"]);
        const fs = filters.slice(0, 5).filter((f) => f && typeof f === "object");
        mine.set(subId, fs);
        if (this.latest && fs.some((f) => matchFilter(f, this.latest!))) this.send(ws, ["EVENT", subId, this.latest]);
        return this.send(ws, ["EOSE", subId]);
      }
      if (type === "CLOSE") this.subs.get(ws)?.delete(String(msg[1]));
    });
  }

  private send(ws: WebSocket, msg: unknown[]) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
