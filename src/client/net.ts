// Talking to the game: one websocket to the game's own Nostr relay. Game state arrives as
// the show's signed event; player actions go out as events signed by a key kept in this
// browser. If websockets are blocked (some office networks and VPNs), it falls back to
// plain HTTP polling.

import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { KIND, type PubState } from "../shared/types.ts";

export interface Config {
  showPubkey: string;
  relay: string;
  publicUrl: string;
  demo: boolean;
}

export interface Reply {
  ok: boolean;
  message: string;
}

let offset = 0;
/** The server's clock, so every page counts down the same seconds. */
export const serverNow = () => Date.now() + offset;

export async function loadConfig(): Promise<Config> {
  const r = await fetch("/api/config");
  return r.json();
}

/** ?seat=2 gives a page its own key, so the test lab can run several players in one browser. */
export const SEAT = new URLSearchParams(location.search).get("seat")?.replace(/[^0-9a-z]/gi, "").slice(0, 8) ?? "";
export const KEY = SEAT ? `treasure-tiles.key.${SEAT}` : "treasure-tiles.key";
export function deviceKey(): Uint8Array {
  try {
    const hex = localStorage.getItem(KEY);
    if (hex && /^[0-9a-f]{64}$/.test(hex)) return hexToBytes(hex);
  } catch {
    /* private mode */
  }
  const sk = generateSecretKey();
  try {
    localStorage.setItem(KEY, bytesToHex(sk));
  } catch {
    /* this tab only */
  }
  return sk;
}

export class Conn {
  state: PubState | null = null;
  private ws: WebSocket | null = null;
  private waiting = new Map<string, (r: Reply) => void>();
  private failures = 0;
  private polling: number | null = null;
  readonly sk = deviceKey();
  readonly pubkey = getPublicKey(this.sk);

  constructor(private cfg: Config, private onState: (s: PubState) => void, private onStatus: (online: boolean) => void = () => {}) {
    this.connect();
    void this.poll(); // first state as fast as possible
  }

  private connect() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.relay);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.onStatus(true);
      this.stopPolling();
      ws.send(JSON.stringify(["REQ", "state", { kinds: [KIND.state], authors: [this.cfg.showPubkey], "#d": ["state"] }]));
    };
    ws.onmessage = (m) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg[0] === "EVENT") this.take((msg[2] as { content: string; pubkey: string }) ?? null);
      if (msg[0] === "OK") {
        const cb = this.waiting.get(String(msg[1]));
        if (cb) {
          this.waiting.delete(String(msg[1]));
          cb({ ok: !!msg[2], message: String(msg[3] ?? "") });
        }
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.onStatus(false);
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry() {
    this.failures++;
    if (this.failures >= 2) this.startPolling();
    setTimeout(() => this.connect(), Math.min(5000, 400 * this.failures));
  }

  private startPolling() {
    if (this.polling !== null) return;
    this.polling = window.setInterval(() => void this.poll(), 1200);
  }
  private stopPolling() {
    if (this.polling !== null) clearInterval(this.polling);
    this.polling = null;
  }
  private async poll() {
    try {
      const r = await fetch("/api/state");
      const { event } = await r.json();
      if (event) this.take(event);
    } catch {
      /* offline for now */
    }
  }

  private take(ev: { content: string; pubkey: string } | null) {
    if (!ev || ev.pubkey !== this.cfg.showPubkey) return;
    let s: PubState;
    try {
      s = JSON.parse(ev.content);
    } catch {
      return;
    }
    if (this.state && s.v < this.state.v && s.gameId === this.state.gameId) return;
    offset = s.now - Date.now();
    this.state = s;
    this.onState(s);
  }

  /** Sign with this browser's key and send. */
  act(kind: number, content: unknown, tags: string[][] = []): Promise<Reply> {
    // A random marker makes every action unique, so two identical shots in one second aren't
    // mistaken for a retry of the same event.
    const nonce = Math.random().toString(36).slice(2, 10);
    const ev = finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [...tags, ["n", nonce]], content: JSON.stringify(content) }, this.sk);
    return this.send(ev);
  }

  /** Send an event someone else signed (the Nostr extension's link event). */
  send(ev: EventTemplate & { id: string; sig: string; pubkey: string }): Promise<Reply> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          this.waiting.delete(ev.id);
          resolve(this.http(ev)); // no answer over the socket: try HTTP (the relay ignores repeats)
        }, 4000);
        this.waiting.set(ev.id, (r) => {
          clearTimeout(t);
          resolve(r);
        });
        this.ws!.send(JSON.stringify(["EVENT", ev]));
      });
    }
    return this.http(ev);
  }

  private async http(ev: unknown): Promise<Reply> {
    try {
      const r = await fetch("/api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: ev }) });
      const j = await r.json();
      void this.poll();
      return { ok: !!j.ok, message: String(j.message ?? j.error ?? "") };
    } catch {
      return { ok: false, message: "error: no connection, try again" };
    }
  }
}

/** "blocked: It's The Sea Ostrich's turn" -> "It's The Sea Ostrich's turn" */
export function plain(message: string) {
  return message.replace(/^[a-z-]+:\s*/, "");
}
