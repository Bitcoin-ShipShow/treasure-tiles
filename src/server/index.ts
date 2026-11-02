// The server: serves the three pages, runs the game's own Nostr relay, and referees.

import express, { type Request, type Response } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { findImage } from "./tiles.ts";
import { Game, GameError } from "./game.ts";
import { GameRelay } from "./relay.ts";
import { Bots } from "./bots.ts";
import { fetchProfile } from "./profiles.ts";
import { Badges } from "./badges.ts";
import { invoiceAmountIs, Wallet } from "./wallet.ts";
import { bech32 } from "@scure/base";
import { decode as nip19decode } from "nostr-tools/nip19";
import { KIND } from "../shared/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotEnv(join(root, ".env"));

const PORT = parseInt(process.env.PORT || "8090", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const DATA_DIR = resolve(root, process.env.DATA_DIR || "data");
const DEMO = process.env.DEMO === "1";
mkdirSync(DATA_DIR, { recursive: true });

const HOST_TOKEN = secretFile("host-token.txt", process.env.HOST_TOKEN, () => randomBytes(12).toString("hex"));
const SHOW_KEY = hexToBytes(secretFile("show.key", process.env.SHOW_KEY_HEX, () => bytesToHex(generateSecretKey())));
const SHOW_PUBKEY = getPublicKey(SHOW_KEY);

const game = new Game({ dataDir: DATA_DIR, imagesDir: join(root, "puzzles/images") });
await game.init();

// The top of the guess dial: the live Bitcoin block height (an estimate from the clock if the
// block explorer can't be reached).
async function refreshTip() {
  try {
    const r = await fetch("https://mempool.space/api/blocks/tip/height", { signal: AbortSignal.timeout(8000) });
    const h = Number(await r.text());
    if (Number.isFinite(h) && h > 800_000) game.tipHeight = h;
  } catch {
    /* keep the estimate */
  }
}
void refreshTip();
setInterval(() => void refreshTip(), 10 * 60_000).unref();
// Nostr badges for round winners and the champion (only players signed in with Nostr)
const BADGE_IMAGES = (process.env.BADGE_IMAGE_BASE || `${PUBLIC_URL}/badges`).replace(/\/+$/, "");
const badges = new Badges(SHOW_KEY, SHOW_PUBKEY, BADGE_IMAGES, DATA_DIR);
if (BADGE_IMAGES.startsWith("https://") && !DEMO) void badges.define().catch(() => {});
const realPubkey = (pk: string) => {
  const npub = game.s.players[pk]?.npub;
  try {
    return npub ? (nip19decode(npub).data as string) : null;
  } catch {
    return null;
  }
};
game.onFinish = (f) => {
  if (DEMO) return;
  const award = (pk: string, id: "round" | "champion", note: string) => {
    const to = realPubkey(pk);
    if (!to || game.s.players[pk]?.bot) return;
    game.giveBadge(pk, id);
    void badges.award(id, to, note).catch((e) => console.warn("[badges]", e.message));
  };
  const top = f.guesses?.[0];
  if (top && top.points > 0) award(top.pk, "round", `Won a round of Treasure Tiles: ${game.puzzleInfo.title}`);
  if (f.stage === "final" && f.ranking[0]) award(f.ranking[0].pk, "champion", "Champion of Treasure Tiles on the Bitcoin Shipshow");
};

// The game's own wallet pays the winner as soon as they send their Lightning address.
const wallet = new Wallet(DATA_DIR);
async function payOut(pk: string) {
  const p = game.s.show.payouts?.[pk];
  // scan-to-receive prizes are paid when the winner's wallet asks (see /lnurlw)
  if (!p || p.token || p.status === "paid" || p.status === "paying" || !wallet.connected) return;
  game.setPayout(pk, { status: "paying" });
  try {
    await wallet.payAddress(p.address, p.sats, "Treasure Tiles prize from the Bitcoin Shipshow 🏴‍☠️");
    game.setPayout(pk, { status: "paid" });
  } catch (e) {
    game.setPayout(pk, { status: "failed", error: (e as Error).message.slice(0, 200) });
  }
}
game.onClaim = (pk) => void payOut(pk);

/** LUD-01: a URL as a bech32 "lnurl…" string, the form wallets scan. */
function lnurlFor(url: string) {
  return bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 2000).toUpperCase();
}

const bots = new Bots(game);
if (bots.count) bots.run();

// ───── the relay: actions in, state out ─────
const relay = new GameRelay(async (ev: Event) => {
  try {
    const body = parse(ev.content);
    if (ev.kind === KIND.join) return game.join(ev.pubkey, String(body.name ?? ""), { avatar: Number(body.avatar) || undefined });
    if (ev.kind === KIND.guess) return game.guess(ev.pubkey, String(body.text ?? ""));
    if (ev.kind === KIND.fire) return game.fire(ev.pubkey, Number(body.angle), Number(body.power));
    if (ev.kind === KIND.pirate) return game.launchPirate(ev.pubkey);
    if (ev.kind === KIND.prize) {
      if (!body.qr) return game.claimPrize(ev.pubkey, String(body.address ?? ""));
      if (!wallet.connected) return { ok: false, message: "blocked: Scan-to-receive needs the game wallet: enter a Lightning address instead" };
      return { ok: true, message: `prizeqr: ${lnurlFor(`${PUBLIC_URL}/lnurlw/${game.prizeQr(ev.pubkey)}`)}` };
    }
    if (ev.kind === KIND.height) return game.lockHeight(ev.pubkey, Number(body.height));
    if (ev.kind === KIND.link) {
      // Signed by the player's real Nostr key, naming the device key that plays for it.
      const device = ev.tags.find((t) => t[0] === "p")?.[1];
      if (!device || !game.s.players[device]) return { ok: false, message: "blocked: join with a name first" };
      game.link(device, npubEncode(ev.pubkey), {});
      void fetchProfile(ev.pubkey).then((p) => game.s.players[device] && game.link(device, npubEncode(ev.pubkey), p)).catch(() => {});
      return { ok: true, message: "linked" };
    }
    return { ok: false, message: "blocked: unknown action" };
  } catch (e) {
    if (e instanceof GameError) return { ok: false, message: `blocked: ${e.message}` };
    console.error(e);
    return { ok: false, message: "error: something went wrong" };
  }
});
relay.showPubkey = SHOW_PUBKEY;

// At most PUBLISH_EVERY ms between updates: with 20 ships firing every second, sending every
// change separately would flood phones (each update is the whole state). A shooter's own result
// (the peek) goes straight back in the reply to their shot, so it doesn't wait for this.
const PUBLISH_EVERY = 200;
let pending: NodeJS.Timeout | null = null;
let lastPublish = 0;
function publishState() {
  pending = null;
  lastPublish = Date.now();
  const ev = finalizeEvent({ kind: KIND.state, created_at: Math.floor(Date.now() / 1000), tags: [["d", "state"]], content: JSON.stringify(game.publicState()) }, SHOW_KEY);
  relay.publish(ev);
}
game.onChange(() => {
  pending ??= setTimeout(publishState, Math.max(25, lastPublish + PUBLISH_EVERY - Date.now())); // a burst goes out as one update
});
publishState();
setInterval(() => game.tick(), 100).unref();
setInterval(() => !pending && publishState(), 10_000).unref(); // keeps page clocks in step

// ───── HTTP ─────
const app = express();
app.set("trust proxy", "loopback, linklocal, uniquelocal");
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    const status = e instanceof GameError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.status(status).json({ error: (e as Error).message });
  }
};
function isHost(t: unknown) {
  if (typeof t !== "string" || t.length !== HOST_TOKEN.length) return false;
  let d = 0;
  for (let i = 0; i < t.length; i++) d |= t.charCodeAt(i) ^ HOST_TOKEN.charCodeAt(i);
  return d === 0;
}
const host = (fn: Handler) =>
  wrap((req, res) => {
    if (!isHost(req.get("x-host-token"))) throw new GameError("Wrong host password", 401);
    return fn(req, res);
  });

const pub = join(root, "public");
app.get("/", (_req, res) => res.redirect("/play"));
for (const page of ["play", "board", "host", "lab", "preview"]) app.get(`/${page}`, (_req, res) => res.sendFile(join(pub, `${page}.html`)));
app.use(express.static(pub, { index: false }));

// Tile pictures: only served once that tile has fallen.
// The intro's practice picture: puzzles/images/practice.(png|jpg|webp) if the host added one, else the stand-in.
app.get("/practice-image", (_req, res) => {
  const f = findImage(join(root, "puzzles/images"), "practice");
  res.set("Cache-Control", "no-cache");
  res.sendFile(f ?? join(root, "public/art/practice-standin.jpg"));
});
app.get("/tile/:game/:file", (req, res) => {
  const f = game.tileFile(String(req.params.game), String(req.params.file));
  if (!f || !existsSync(f)) return void res.status(404).send("Not yet, matey");
  res.set("Cache-Control", "private, max-age=3600").sendFile(f);
});

// Scan to receive (LNURL-withdraw, LUD-03): the winner's wallet asks for the prize, sends an
// invoice for exactly that amount, and the game's wallet pays it. Each code works once.
app.get("/lnurlw/:token", (req, res) => {
  const hit = game.prizeByToken(String(req.params.token));
  if (!hit || hit.p.status !== "waiting") return void res.json({ status: "ERROR", reason: hit?.p.status === "paid" ? "This prize is already paid" : "This prize code isn't valid any more" });
  const msat = hit.p.sats * 1000;
  res.json({ tag: "withdrawRequest", callback: `${PUBLIC_URL}/lnurlw/${req.params.token}/pay`, k1: req.params.token, defaultDescription: "Treasure Tiles prize from the Bitcoin Shipshow 🏴‍☠️", minWithdrawable: msat, maxWithdrawable: msat });
});
app.get("/lnurlw/:token/pay", (req, res) => {
  const token = String(req.params.token);
  const hit = game.prizeByToken(token);
  const pr = String(req.query.pr ?? "");
  if (!hit || String(req.query.k1) !== token || hit.p.status !== "waiting") return void res.json({ status: "ERROR", reason: "This prize code isn't valid any more" });
  if (!invoiceAmountIs(pr, hit.p.sats * 1000)) return void res.json({ status: "ERROR", reason: `The invoice must be for exactly ${hit.p.sats} sats` });
  game.setPayout(hit.pk, { status: "paying" });
  res.json({ status: "OK" }); // the spec: answer first, then pay
  wallet.payInvoice(pr).then(
    () => game.setPayout(hit.pk, { status: "paid" }),
    (e) => game.setPayout(hit.pk, { status: "failed", error: (e as Error).message.slice(0, 200) }),
  );
});
app.get("/api/config", wrap(() => ({ showPubkey: SHOW_PUBKEY, relay: PUBLIC_URL.replace(/^http/, "ws") + "/relay", publicUrl: PUBLIC_URL, demo: DEMO })));
app.get("/api/state", wrap(() => ({ event: relay.state })));
app.post(
  "/api/publish",
  wrap(async (req, res) => {
    const r = await relay.submit(req.body?.event);
    if (!r.ok) res.status(400);
    return r;
  }),
);
app.get(
  "/api/qr.svg",
  wrap(async (req, res) => {
    const text = String(req.query.text ?? "").slice(0, 1000) || `${PUBLIC_URL}/play`;
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=3600").send(await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" }));
  }),
);

app.get("/api/host/state", host(async () => ({ ...game.secrets(), connections: relay.connections, bots: bots.count, wallet: { connected: wallet.connected, alias: wallet.alias, balance: await wallet.balance() } })));
app.post("/api/host/wallet", host(async (req) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) return wallet.disconnect();
  try {
    await wallet.connect(url);
  } catch (e) {
    throw new GameError((e as Error).message);
  }
}));
app.post("/api/host/pay", host((req) => {
  const pk = String(req.body?.pk ?? "");
  const p = game.s.show.payouts?.[pk];
  if (!p) throw new GameError("No address from that winner yet");
  if (p.status === "failed") game.setPayout(pk, { status: "waiting" });
  void payOut(pk); // (a scan-to-receive prize just waits for the winner to scan again)
}));
app.post("/api/host/check", host(() => ({ ok: true })));
app.post("/api/host/new", host(async (req) => game.newGame(String(req.body?.puzzleId ?? ""))));
app.post("/api/host/start", host(() => game.start()));
app.post("/api/host/next-round", host(async (req) => (await game.nextRound(String(req.body?.puzzleId ?? "")), req.body?.start ? game.start() : undefined)));
app.post("/api/host/final", host(async (req) => (await game.startFinal(String(req.body?.puzzleId ?? "")), req.body?.start ? game.start() : undefined)));
app.post("/api/host/new-show", host(async (req) => game.newShow(String(req.body?.puzzleId ?? ""))));
app.post("/api/host/pause", host(() => game.pause()));
app.post("/api/host/resume", host(() => game.resume()));
app.post("/api/host/add-time", host((req) => game.addTime(Number(req.body?.seconds) || 10)));
app.post("/api/host/end", host(() => game.end()));
app.post("/api/host/settings", host((req) => game.setSettings(req.body ?? {})));
app.post("/api/host/remove", host((req) => game.removePlayer(String(req.body?.pk))));
app.post("/api/host/hide", host((req) => game.hideFeed(Number(req.body?.id), req.body?.hidden !== false)));
app.post("/api/host/bots/add", host((req) => bots.add(Math.min(30, Number(req.body?.count) || 6))));
app.post("/api/host/bots/clear", host(() => bots.clear()));
app.post("/api/host/players/clear", host(() => (bots.clear(), game.clearPlayers())));

const server = app.listen(PORT, process.env.HOST || "0.0.0.0", () => {
  console.log(`\n🏴‍☠️  ${game.settings.title}${DEMO ? "  (demo)" : ""}`);
  console.log(`   Players:  ${PUBLIC_URL}/play`);
  console.log(`   Board:    ${PUBLIC_URL}/board   (OBS browser source, 1920x1080)`);
  console.log(`   Host:     ${PUBLIC_URL}/host    password: ${HOST_TOKEN}`);
  console.log(`   Relay:    ${PUBLIC_URL.replace(/^http/, "ws")}/relay`);
  console.log(`   Show key: ${npubEncode(SHOW_PUBKEY)}\n`);
});
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/relay")) relay.wss.handleUpgrade(req, socket, head, (ws) => relay.wss.emit("connection", ws, req));
  else socket.destroy();
});
app.get("/relay", (req, res) => {
  if (req.get("accept")?.includes("application/nostr+json")) {
    return void res.set("Access-Control-Allow-Origin", "*").json({ name: `${game.settings.title} game relay`, description: "Only this game's events. Nothing is stored or forwarded.", pubkey: SHOW_PUBKEY, supported_nips: [1, 11] });
  }
  res.type("text").send("This is a Nostr relay. Connect with a websocket.");
});

process.on("unhandledRejection", (e) => console.error("[unhandled rejection]", e));
const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function parse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function secretFile(name: string, fromEnv: string | undefined, make: () => string) {
  if (fromEnv) return fromEnv;
  const f = join(DATA_DIR, name);
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const v = make();
  writeFileSync(f, v, { mode: 0o600 });
  return v;
}

function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
