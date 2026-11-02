// End to end: a real server process, real websockets, real signed Nostr events.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { KIND, type PubState } from "../src/shared/types.ts";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "tt-srv-"));
let proc: ChildProcess;
let TOKEN = "";

before(async () => {
  proc = spawn("npx", ["tsx", "src/server/index.ts"], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, HOST: "127.0.0.1", PUZZLES_FILE: "puzzles/show.example.json" }, stdio: "pipe" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/config`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  TOKEN = readFileSync(join(DATA, "host-token.txt"), "utf8").trim();
});
after(() => {
  proc.kill();
});

const host = (path: string, body: unknown = {}) => fetch(`${BASE}/api/host/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-host-token": TOKEN }, body: JSON.stringify(body) }).then((r) => r.json());

class Player {
  sk = generateSecretKey();
  pk = getPublicKey(this.sk);
  ws!: WebSocket;
  state: PubState | null = null;
  stateEvent: Event | null = null;
  private waiting = new Map<string, (r: [boolean, string]) => void>();
  async open(showPubkey: string) {
    this.ws = new WebSocket(`ws://localhost:${PORT}/relay`);
    await new Promise((r) => this.ws.once("open", r));
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m[0] === "EVENT") {
        this.stateEvent = m[2];
        this.state = JSON.parse(m[2].content);
      }
      if (m[0] === "OK") this.waiting.get(m[1])?.([m[2], m[3]]);
    });
    this.ws.send(JSON.stringify(["REQ", "s", { kinds: [KIND.state], authors: [showPubkey], "#d": ["state"] }]));
  }
  sendRaw(ev: Event): Promise<[boolean, string]> {
    return new Promise((resolve) => {
      this.waiting.set(ev.id, resolve);
      this.ws.send(JSON.stringify(["EVENT", ev]));
    });
  }
  act(kind: number, content: unknown) {
    return this.sendRaw(finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(content) }, this.sk));
  }
}

test("a full round over the relay: join, wrong turn, guess, duplicate, forged, tiles", async () => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  const players = [new Player(), new Player(), new Player()];
  for (const p of players) await p.open(cfg.showPubkey);
  for (const [i, p] of players.entries()) {
    const [ok, msg] = await p.act(KIND.join, { name: `Pirate ${i}` });
    assert.ok(ok, msg);
    assert.match(msg, /^aboard: /);
  }
  await host("settings", { tileEverySeconds: 0, letterEverySeconds: 0, countdownSeconds: 0 });
  await host("new", { puzzleId: "pizza" });
  await host("start");
  await new Promise((r) => setTimeout(r, 400));
  const s = players[0].state!;
  assert.equal(s.phase, "open");
  // The state is a real signed Nostr event from the show's key.
  assert.ok(verifyEvent(players[0].stateEvent!));
  assert.equal(players[0].stateEvent!.pubkey, cfg.showPubkey);

  const [up, other] = players;
  const ev = finalizeEvent({ kind: KIND.height, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ height: 700000 }) }, up.sk);
  const [ok2, m2] = await up.sendRaw(ev);
  assert.ok(ok2, m2);
  assert.equal(m2, "locked: 700000");
  // The same event again (a retry, or a copy over HTTP) is not counted twice.
  const [, m3] = await up.sendRaw(ev);
  assert.match(m3, /^duplicate/);
  const viaHttp = await (await fetch(`${BASE}/api/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: ev }) })).json();
  assert.match(viaHttp.message, /^duplicate/);
  // One guess per round: a second one is refused. Typed guesses aren't how this game is played.
  assert.equal((await other.act(KIND.height, { height: 650000 }))[1], "locked: 650000");
  assert.match((await other.act(KIND.height, { height: 57043 }))[1], /^blocked: You've already locked in/);
  assert.match((await other.act(KIND.guess, { text: "57043" }))[1], /dial/);

  // A forged signature is refused.
  const forged = { ...finalizeEvent({ kind: KIND.guess, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ text: "foot" }) }, generateSecretKey()), pubkey: up.pk };
  const [ok4, m4] = await up.sendRaw(forged as Event);
  assert.equal(ok4, false);
  assert.match(m4, /^invalid/);

  // Kinds that aren't this game's are refused (it's not a general relay).
  const note = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "gm" }, up.sk);
  const [ok5, m5] = await up.sendRaw(note);
  assert.equal(ok5, false);
  assert.match(m5, /^blocked/);

  // Cannon: a weak shot splashes; a second shot inside the reload time is refused.
  assert.equal((await players[2].act(KIND.fire, { angle: 0, power: 0.02 }))[1], "short");
  assert.match((await players[2].act(KIND.fire, { angle: 0, power: 0.03 }))[1], /Reloading/);

  // Slabs: an uncovered one's picture is served; a covered one's isn't; nothing secret in the state.
  await new Promise((r) => setTimeout(r, 200));
  const st = up.state!;
  const open = st.tiles.find((t) => t.img)!;
  assert.equal((await fetch(`${BASE}${open.img!.url}`)).status, 200);
  assert.equal((await fetch(`${BASE}/tile/${st.gameId}/0000.webp`)).status, 404);
  assert.ok(!JSON.stringify(up.state).includes("57043"), "the answer isn't in the state");
  assert.ok(!JSON.stringify(up.state).includes("650000"), "nor anyone's guess");

  // Host endpoints need the password.
  assert.equal((await fetch(`${BASE}/api/host/state`)).status, 401);
  for (const p of players) p.ws.close();
});

test("rate limit: a script spamming events gets told to slow down", async () => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  const p = new Player();
  await p.open(cfg.showPubkey);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => p.act(KIND.join, { name: `Spam ${i}` })));
  assert.ok(results.some(([ok, m]) => !ok && /^rate-limited/.test(m)));
  p.ws.close();
});
