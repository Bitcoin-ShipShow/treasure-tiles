// Ways a player can prove who they are:
//  - a browser extension (NIP-07: Alby, nos2x, Keys.band…)
//  - a signer app over Nostr Connect (NIP-46: Amber, nsec.app, Primal's signer…)
//  - a throwaway key made in this browser (only when the host allows guest keys)

import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from "nostr-tools/pure";
import { BunkerSigner, createNostrConnectURI, parseBunkerInput, type BunkerPointer } from "nostr-tools/nip46";
import { decrypt, getConversationKey } from "nostr-tools/nip44";
import type { Event } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

export interface Signer {
  kind: "extension" | "bunker" | "guest";
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<VerifiedEvent>;
}

const STORE = "treasure-tiles.signer";
let pool: SimplePool | null = null;
const getPool = () => (pool ??= new SimplePool({ enableReconnect: true, enablePing: true }));

declare global {
  interface Window {
    nostr?: { getPublicKey(): Promise<string>; signEvent(e: EventTemplate): Promise<VerifiedEvent> };
  }
}

function save(v: unknown) {
  try {
    localStorage.setItem(STORE, JSON.stringify(v));
  } catch {
    /* private mode: stay logged in for this tab only */
  }
}

export function forgetSigner() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
}

export function hasExtension() {
  return typeof window.nostr?.signEvent === "function";
}

export function extensionSigner(): Signer {
  if (!window.nostr) throw new Error("No Nostr browser extension found");
  save({ kind: "extension" });
  return {
    kind: "extension",
    getPublicKey: () => window.nostr!.getPublicKey(),
    signEvent: (t) => window.nostr!.signEvent(t),
  };
}

export function guestSigner(): Signer {
  let hex: string | null = null;
  try {
    const stored = JSON.parse(localStorage.getItem(STORE) || "null");
    if (stored?.kind === "guest") hex = stored.sk;
  } catch {
    /* ignore */
  }
  const sk = hex ? hexToBytes(hex) : generateSecretKey();
  save({ kind: "guest", sk: bytesToHex(sk) });
  return {
    kind: "guest",
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (t) => finalizeEvent(t, sk),
  };
}

/**
 * Most signers (Primal, Amber) use your own key to talk to us, so we can show you as logged
 * in straight away instead of waiting on a round trip to a signer app that may be in the
 * background. We still ask for the real key, and switch if it's different.
 */
function wrapBunker(b: BunkerSigner, likelyPubkey?: string): Signer {
  let cached: Promise<string> | null = null;
  const ask = () => (cached ??= withTimeout(b.getPublicKey(), 45_000, "Your signer didn't respond").catch((e) => ((cached = null), Promise.reject(e))));
  return {
    kind: "bunker",
    getPublicKey: () => {
      if (!likelyPubkey) return ask();
      void ask().catch(() => {}); // confirm in the background; don't block on a sleeping signer
      return Promise.resolve(likelyPubkey);
    },
    signEvent: (t) => b.signEvent(t),
  };
}

/** Paste-a-bunker-URL flow (bunker://… or name@nsec.app). */
export async function bunkerFromInput(input: string): Promise<Signer> {
  const bp = await parseBunkerInput(input.trim());
  if (!bp) throw new Error("That isn't a bunker:// link or a NIP-05 with a signer");
  const clientSk = generateSecretKey();
  const b = BunkerSigner.fromBunker(clientSk, bp, { pool: getPool(), onauth: (url) => window.open(url, "_blank") });
  await withTimeout(b.connect(), 60_000, "Signer did not answer");
  save({ kind: "bunker", sk: bytesToHex(clientSk), bp });
  return wrapBunker(b);
}

/**
 * Nostr Connect flow: we show a nostrconnect:// link/QR, the signer app (Primal, Amber,
 * nsec.app…) opens it, approves, and replies to us over relays.
 *
 * Built for phones: opening the signer sends this page to the background, and iOS
 * kills its websockets. So the pending login is saved first, a lost connection is not a
 * failure, and the show's own relay keeps signer replies for a few minutes so we can pick
 * up the one we missed when the page comes back. Only a timeout or cancel ends it.
 */
const PENDING = "whosezap.pendingConnect";
const PERMS = ["get_public_key", "sign_event:1", "sign_event:25903"];

interface Pending {
  sk: string;
  secret: string;
  relays: string[];
  createdAt: number; // seconds
}

export function connectRelays() {
  // public relays only: the game's own relay carries game actions, not signer traffic
  return ["wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"];
}

function uriFor(p: Pending, callback?: string) {
  let uri = createNostrConnectURI({
    clientPubkey: getPublicKey(hexToBytes(p.sk)),
    relays: p.relays,
    secret: p.secret,
    name: "Treasure Tiles",
    url: location.origin,
    perms: PERMS,
  });
  // Primal's iOS signer sends you back to this URL after approving (other signers ignore it).
  if (callback) uri += `&callback=${encodeURIComponent(callback)}`;
  return uri;
}

export function pendingConnect(): Pending | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING) || "null") as Pending | null;
    if (p && Date.now() / 1000 - p.createdAt < 600) return p;
  } catch {
    /* ignore */
  }
  clearPending();
  return null;
}

function clearPending() {
  try {
    localStorage.removeItem(PENDING);
  } catch {
    /* ignore */
  }
}

/** Starts (or resumes) a Nostr Connect login. Saves the session before anything leaves the page. */
export function startNostrConnect(opts: { resume?: boolean } = {}): { uri: string; sameDeviceUri: string; wait: (signal: AbortSignal) => Promise<Signer> } {
  let p = opts.resume ? pendingConnect() : null;
  if (!p) {
    p = { sk: bytesToHex(generateSecretKey()), secret: bytesToHex(generateSecretKey()).slice(0, 16), relays: connectRelays(), createdAt: Math.floor(Date.now() / 1000) };
    try {
      localStorage.setItem(PENDING, JSON.stringify(p));
    } catch {
      /* private mode: same-device login can't survive a reload, but the QR still works */
    }
  }
  const session = p;
  const callback = `${location.origin}/play?signer=back`;
  return {
    uri: uriFor(session),
    sameDeviceUri: uriFor(session, callback),
    wait: (signal) => waitForSigner(session, signal),
  };
}

function waitForSigner(p: Pending, signal: AbortSignal): Promise<Signer> {
  const clientSk = hexToBytes(p.sk);
  const clientPk = getPublicKey(clientSk);
  const pool = getPool();
  return new Promise((resolve, reject) => {
    let done = false;
    let sub: { close: () => void } | null = null;
    const filter = { kinds: [24133], "#p": [clientPk], since: p.createdAt - 30 };
    const finish = (err: Error | null, signer?: Signer) => {
      if (done) return;
      done = true;
      sub?.close();
      clearInterval(poll);
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("pageshow", catchUp);
      window.removeEventListener("focus", catchUp);
      window.removeEventListener("online", catchUp);
      if (err) reject(err);
      else resolve(signer!);
    };
    const check = (ev: Event) => {
      if (done) return;
      try {
        const res = JSON.parse(decrypt(ev.content, getConversationKey(clientSk, ev.pubkey)));
        if (res.result !== p.secret && res.result !== "ack") return;
        if (res.result === "ack" && !res.id) return;
        nlog(`signer replied (${ev.pubkey.slice(0, 8)}…), connection approved`);
        const bp: BunkerPointer = { pubkey: ev.pubkey, relays: p.relays, secret: p.secret };
        const b = BunkerSigner.fromBunker(clientSk, bp, { pool });
        save({ kind: "bunker", sk: p.sk, bp });
        clearPending();
        finish(null, wrapBunker(b, ev.pubkey));
      } catch {
        /* not for us, or not decryptable: keep waiting */
      }
    };
    const listen = () => {
      sub?.close();
      sub = pool.subscribeMany(p.relays, filter as never, { onevent: check });
    };
    // Coming back from the signer app: reconnect and fetch the reply we may have missed.
    const catchUp = () => {
      if (done || document.visibilityState === "hidden") return;
      nlog("page visible again: reconnecting and checking for the signer's reply");
      listen();
      pool.querySync(p.relays, filter as never, { maxWait: 4000 }).then((evs) => evs.forEach(check), () => {});
    };
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("pageshow", catchUp);
    window.addEventListener("focus", catchUp);
    window.addEventListener("online", catchUp);
    const poll = setInterval(catchUp, 5000);
    const timeout = setTimeout(() => finish(new Error("The signer didn't answer within 5 minutes. Try again.")), 300_000);
    signal.addEventListener("abort", () => finish(new Error("cancelled")));
    nlog(`waiting for signer on ${p.relays.length} relays`);
    listen();
    catchUp();
  });
}

/** A small on-device log of the login handshake (open /play?debug=1 to see it). */
export function nlog(msg: string) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  console.log(`[login] ${line}`);
  try {
    const log = JSON.parse(localStorage.getItem("treasure-tiles.loginLog") || "[]") as string[];
    log.push(line);
    localStorage.setItem("treasure-tiles.loginLog", JSON.stringify(log.slice(-40)));
  } catch {
    /* ignore */
  }
}

/** Restores the signer used last time, if any. */
export function restoreSigner(): Signer | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE) || "null");
    if (!stored) return null;
    if (stored.kind === "extension") return hasExtension() ? extensionSigner() : null;
    if (stored.kind === "guest") return guestSigner();
    if (stored.kind === "bunker") {
      const b = BunkerSigner.fromBunker(hexToBytes(stored.sk), stored.bp as BunkerPointer, { pool: getPool() });
      return wrapBunker(b, (stored.bp as BunkerPointer).pubkey);
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
