// Looks up a Nostr profile (kind 0: name and picture) on a few public relays, for players
// who log in with their real Nostr identity. Read-only: nothing is ever published there.

import WebSocket from "ws";

const RELAYS = (process.env.PROFILE_RELAYS ?? "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net").split(",").map((s) => s.trim()).filter(Boolean);

export async function fetchProfile(pubkey: string, timeoutMs = 4000): Promise<{ name?: string; picture?: string }> {
  const results = await Promise.all(RELAYS.map((r) => ask(r, pubkey, timeoutMs)));
  const newest = results.filter(Boolean).sort((a, b) => b!.created_at - a!.created_at)[0];
  if (!newest) return {};
  try {
    const c = JSON.parse(newest.content);
    return { name: String(c.display_name || c.name || "").slice(0, 40) || undefined, picture: typeof c.picture === "string" ? c.picture : undefined };
  } catch {
    return {};
  }
}

function ask(url: string, pubkey: string, timeoutMs: number): Promise<{ created_at: number; content: string } | null> {
  return new Promise((resolve) => {
    let best: { created_at: number; content: string } | null = null;
    let ws: WebSocket;
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(best);
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      ws = new WebSocket(url, { headers: { "User-Agent": "treasure-tiles/0.1" } });
    } catch {
      return done();
    }
    ws.on("error", done); // a dead relay must not crash the server
    ws.on("open", () => ws.send(JSON.stringify(["REQ", "p", { kinds: [0], authors: [pubkey], limit: 1 }])));
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m[0] === "EVENT" && m[2]?.pubkey === pubkey && (!best || m[2].created_at > best.created_at)) best = m[2];
        if (m[0] === "EOSE") done();
      } catch {
        /* ignore */
      }
    });
  });
}
