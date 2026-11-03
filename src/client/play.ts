// The players' page. Join with a name, learn to fire (three practice shots), then each round:
// shoot the wall to uncover the picture, and dial in the block height when it happened.
// No typing after joining: the guess is a dial, so the phone keyboard never covers the game.

import { KIND, PIRATE_FLIGHT_MS, PIRATE_SPLAT_MS, PIRATES_EACH, type PubState } from "../shared/types.ts";
import { MAX_ANGLE } from "../shared/cannon.ts";
import { dayMonthYear, heightToTime, monthYear, offText } from "../shared/blocks.ts";
import { Conn, loadConfig, plain, SEAT, serverNow } from "./net.ts";
import { SimplePool } from "nostr-tools/pool";
import { extensionSigner, hasExtension, pendingConnect, restoreSigner, startNostrConnect, withTimeout, type Signer } from "./signer.ts";
import { $, clockText, countdown, Cove, datesOn, wheelsOffNow, guessVerdict, ordinal, pirateCheer, pirateConfetti, upNext, esc, fmt, krakenOverlay, miniBoard, pirateShip, pirateSplat, playerColor, rankOf, roundLabel, secondsLeft, showPoints, toast } from "./ui.ts";

// ?reset starts over as a brand-new player: forget this browser's game key, name, intro and sign-in
if (new URLSearchParams(location.search).has("reset")) {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("treasure-tiles.")) localStorage.removeItem(k);
  } catch {
    /* private mode: nothing saved anyway */
  }
  location.replace(location.pathname);
}
const cfg = await loadConfig();
// redraw at most once per screen refresh, however many updates arrive
let drawQueued = false;
const conn = new Conn(cfg, () => {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    if (conn.state) render(conn.state);
  });
}, (on) => document.body.classList.toggle("offline", !on));
const me = conn.pubkey;
const view = new Cove($("#cove-box"), { me, firstPerson: true });
const params = new URLSearchParams(location.search);
let autoJoined = false;
let lastFire = 0;

document.body.classList.add(matchMedia("(pointer: coarse)").matches ? "touch" : "mouse");
countdown($("#countdown"), () => (document.body.dataset.screen === "game" ? conn.state : null));
setInterval(() => conn.state && tick(conn.state), 250);
// the slider panel is pinned to the bottom; keep the page (and the round slate) clear of it
let lastDialH = 0;
new ResizeObserver(() => {
  const h = Math.max($("#dial").offsetHeight, $("#result").offsetHeight);
  document.body.style.setProperty("--dial-h", `${h}px`);
  // on a computer the game screen is sized to what's left above the panel: re-fit it
  if (h && Math.abs(h - lastDialH) > 4) {
    lastDialH = h;
    dispatchEvent(new Event("resize"));
  }
}).observe($("#dial"));

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* fine */
    }
  },
};

// ───── joining: sign in with Nostr, or a pirate name and an avatar ─────
const nameInput = $("#name") as HTMLInputElement;
nameInput.value = store.get(`treasure-tiles.name${SEAT}`) ?? "";
let avatar = Number(store.get(`treasure-tiles.avatar${SEAT}`)) || 1 + Math.floor(Math.random() * 16);
$("#avatars").innerHTML = Array.from({ length: 16 }, (_, i) => `<button type="button" class="si-av" data-av="${i + 1}"><img src="/avatars/${i + 1}.svg" alt=""></button>`).join("");
const markAvatar = () => document.querySelectorAll<HTMLElement>(".si-av").forEach((b) => b.classList.toggle("on", Number(b.dataset.av) === avatar));
markAvatar();
$("#avatars").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>(".si-av");
  if (!b) return;
  avatar = Number(b.dataset.av);
  markAvatar();
});
$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return nameInput.focus();
  store.set(`treasure-tiles.name${SEAT}`, name);
  store.set(`treasure-tiles.avatar${SEAT}`, String(avatar));
  nameInput.blur();
  const r = await conn.act(KIND.join, { name, avatar });
  if (!r.ok) toast(plain(r.message), "error");
});

/** The player's real Nostr signer, if they signed in with one (also used to post a note at the end). */
let signer: Signer | null = restoreSigner();
if (hasExtension()) $("#si-ext").hidden = false;
const siMsg = (t: string) => ($("#si-msg").textContent = t);
async function signedIn(sg: Signer) {
  signer = sg;
  siMsg("Signing you in…");
  try {
    const pk = await withTimeout(sg.getPublicKey(), 60_000, "Your signer didn't answer");
    // join with a placeholder name; the server swaps in your Nostr name and picture
    const j = await conn.act(KIND.join, { name: `Pirate ${pk.slice(0, 4)}` });
    if (!j.ok) throw new Error(plain(j.message));
    const ev = await withTimeout(sg.signEvent({ kind: KIND.link, created_at: Math.floor(Date.now() / 1000), tags: [["p", me]], content: "" }), 90_000, "Your signer didn't sign");
    const r = await conn.send(ev);
    if (!r.ok) throw new Error(plain(r.message));
    siMsg("");
  } catch (e) {
    siMsg((e as Error).message);
  }
}
$("#si-ext").addEventListener("click", () => void signedIn(extensionSigner()));
let connectAbort: AbortController | null = null;
$("#si-app").addEventListener("click", async () => {
  const nc = startNostrConnect();
  ($("#si-open") as HTMLAnchorElement).href = nc.sameDeviceUri;
  ($("#si-qr") as HTMLImageElement).src = `/api/qr.svg?text=${encodeURIComponent(nc.uri)}`;
  $("#si-connect").hidden = false;
  connectAbort?.abort();
  connectAbort = new AbortController();
  try {
    const sg = await nc.wait(connectAbort.signal);
    $("#si-connect").hidden = true;
    await signedIn(sg);
  } catch (e) {
    if (!connectAbort.signal.aborted) siMsg((e as Error).message);
  }
});
$("#si-cancel").addEventListener("click", () => {
  connectAbort?.abort();
  $("#si-connect").hidden = true;
});
// back from a signer app on this phone (Primal etc. return to ?signer=back): pick up where we left off
if (params.get("signer") === "back" && pendingConnect()) {
  const nc = startNostrConnect({ resume: true });
  connectAbort = new AbortController();
  nc.wait(connectAbort.signal).then(signedIn, (e) => siMsg((e as Error).message));
}

// ───── brag on Nostr (never automatic: only when the player taps the button) ─────
const NOTE_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
let pool: SimplePool | null = null;
async function postNote(text: string, btn: HTMLButtonElement) {
  if (!signer) return;
  btn.disabled = true;
  btn.textContent = "Posting…";
  try {
    const ev = await withTimeout(signer.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [["t", "bitcoinshipshow"], ["t", "treasuretiles"]], content: text }), 90_000, "Your signer didn't sign");
    pool ??= new SimplePool();
    await Promise.any(pool.publish(NOTE_RELAYS, ev));
    btn.textContent = "✓ Posted to Nostr";
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Post to Nostr";
    toast((e as Error).message || "Couldn't post", "error");
  }
}
function brag(text: string) {
  if (!signer) return "";
  return `<button type="button" class="si-btn si-purple brag" data-note="${esc(text)}">🟣 Post to Nostr</button><div class="brag-preview">“${esc(text)}”</div>`;
}
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".brag");
  if (b) void postNote(b.dataset.note!, b);
});
/** The Lightning address on the player's own Nostr profile, to save them typing it. */
async function myLud16(): Promise<string> {
  if (!signer) return "";
  try {
    const pk = await signer.getPublicKey();
    pool ??= new SimplePool();
    const ev = await withTimeout(pool.get(["wss://purplepag.es", ...NOTE_RELAYS], { kinds: [0], authors: [pk] }), 6000, "slow");
    return String(JSON.parse(ev?.content || "{}").lud16 || "");
  } catch {
    return "";
  }
}

// ───── the intro: aim at a target, knock a little wall open, try the slider ─────
const TRAIN_KEY = `treasure-tiles.intro${SEAT}`;
// ?intro in the address plays it again (for checking it, or for anyone who wants a refresher)
let trainLeft = store.get(TRAIN_KEY) && !params.has("intro") ? 0 : 1;
let introStep = 0;
function showStep(n: number) {
  introStep = n;
  for (const el of document.querySelectorAll<HTMLElement>(".intro-step")) el.hidden = Number(el.dataset.step) !== n;
  const next = $("#intro-next") as HTMLButtonElement;
  next.hidden = true;
  next.textContent = n === 3 ? "LET'S PLAY!" : "NEXT";
  const pond = $("#intro-pond").querySelector("svg");
  pond?.classList.toggle("wall-mode", n >= 1);
  $("#intro-pond").classList.toggle("small", n >= 2);
  $("#intro-dial").hidden = n !== 2;
  const say: Record<number, string> = { 0: "Hit the target!", 1: "Knock the slabs off!", 2: "", 3: "" };
  $("#intro-say").textContent = say[n];
  $("#intro-say").className = "intro-say";
  if (n === 3) next.hidden = false;
}
$("#intro-next").addEventListener("click", () => {
  if (introStep < 3) return showStep(introStep + 1);
  trainLeft = 0;
  store.set(TRAIN_KEY, "1");
  if (conn.state) render(conn.state);
});
// the slider, for practice
const introRange = $("#intro-range") as HTMLInputElement;
const introSet = (v: number) => {
  introRange.value = String(v);
  $("#intro-num").textContent = fmt(v);
  $("#intro-date").textContent = `≈ ${monthYear(heightToTime(v))}`;
};
introRange.addEventListener("input", () => introSet(Number(introRange.value)));
$("#intro-lock").addEventListener("click", () => {
  ($("#intro-lock") as HTMLButtonElement).textContent = "🔒 LOCKED IN";
  navigator.vibrate?.(60);
  setTimeout(() => showStep(3), 700);
});

/** A little pond: your ship at the bottom; first a target, then a small wall of 4 slabs. */
const POND = { w: 400, h: 560, ship: { x: 200, y: 470 }, target: { x: 200, y: 160, r: 46 }, wall: { x: 80, y: 40, w: 240, h: 180 } };
let pondBuilt = false;
let slabsDown = 0;
function buildPond() {
  if (pondBuilt) return;
  pondBuilt = true;
  const tip = conn.state?.tipHeight ?? 950_000;
  introRange.max = String(tip);
  introSet(Math.round(tip / 2 / 1000) * 1000);
  const box = $("#intro-pond");
  const W = POND.wall;
  const slab = (i: number) => {
    const x = W.x + (i % 2) * (W.w / 2);
    const y = W.y + Math.floor(i / 2) * (W.h / 2);
    return `<rect class="pond-slab" data-i="${i}" x="${x}" y="${y}" width="${W.w / 2}" height="${W.h / 2}"/>`;
  };
  box.innerHTML = `<svg viewBox="0 0 ${POND.w} ${POND.h}" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="pondsea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1fa3c9"/><stop offset="1" stop-color="#0b6f99"/></linearGradient>
      <radialGradient id="pondeye" gradientUnits="userSpaceOnUse" cx="${W.x + W.w / 2}" cy="${W.y + W.h / 2}" r="34" spreadMethod="repeat">
        <stop offset="0" stop-color="#e3262f"/><stop offset=".5" stop-color="#e3262f"/><stop offset=".5" stop-color="#fff3df"/><stop offset="1" stop-color="#fff3df"/>
      </radialGradient>
    </defs>
    <rect width="${POND.w}" height="${POND.h}" fill="url(#pondsea)"/>
    <g class="pond-wall">
      <rect x="${W.x - 8}" y="${W.y - 8}" width="${W.w + 16}" height="${W.h + 16}" fill="#f2c94c"/>
      <image href="/practice-image" x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" preserveAspectRatio="xMidYMid slice"/>
      ${[0, 1, 2, 3].map(slab).join("")}
    </g>
    <g transform="translate(${POND.target.x} ${POND.target.y})"><g class="pond-target">
      ${[46, 34, 22, 10].map((r, i) => `<circle r="${r}" fill="${i % 2 ? "#fff3df" : "#e3262f"}" stroke="#4a1a12" stroke-width="2"/>`).join("")}
    </g></g>
    <g class="pond-aim"></g><g class="pond-fx"></g>
    <g transform="translate(${POND.ship.x} ${POND.ship.y + 50}) scale(.3)">${pirateShip(playerColor(me))}</g>
  </svg>`;
  const svg = box.querySelector("svg")!;
  const pt = (e: PointerEvent) => {
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM()!.inverse());
  };
  let start: { x: number; y: number } | null = null;
  let shot: { dx: number; dy: number; power: number } | null = null;
  const aimG = svg.querySelector(".pond-aim")!;
  svg.addEventListener("pointerdown", (e) => {
    if (introStep > 1) return;
    e.preventDefault();
    start = pt(e);
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = pt(e);
    const vx = start.x - p.x;
    const vy = start.y - p.y;
    const len = Math.hypot(vx, vy);
    if (len < 8) return void ((aimG.innerHTML = ""), (shot = null));
    shot = { dx: vx / len, dy: vy / len, power: Math.min(1, len / 260) };
    const L = 50 + shot.power * 160;
    const hue = 120 - shot.power * 120;
    aimG.innerHTML = `<line x1="${POND.ship.x}" y1="${POND.ship.y}" x2="${POND.ship.x + shot.dx * L}" y2="${POND.ship.y + shot.dy * L}" stroke="hsl(${hue} 90% 55%)" stroke-width="7" stroke-linecap="round" stroke-dasharray="11 8"/>`;
  });
  svg.addEventListener("pointerup", () => {
    start = null;
    aimG.innerHTML = "";
    if (shot && shot.power > 0.04) pondFire(shot);
    shot = null;
  });
}
function pondFire(shot: { dx: number; dy: number; power: number }) {
  const svg = $("#intro-pond").querySelector("svg")!;
  const fx = svg.querySelector(".pond-fx")!;
  const reach = shot.power * 560;
  const to = { x: POND.ship.x + shot.dx * reach, y: POND.ship.y + shot.dy * reach };
  const ball = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  ball.setAttribute("r", "9");
  ball.setAttribute("class", "ball");
  fx.appendChild(ball);
  const t0 = performance.now();
  const from = POND.ship;
  const peak = Math.min(from.y, to.y) - 70;
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / 700);
    const x = (1 - k) * (1 - k) * from.x + 2 * (1 - k) * k * ((from.x + to.x) / 2) + k * k * to.x;
    const y = (1 - k) * (1 - k) * from.y + 2 * (1 - k) * k * peak + k * k * to.y;
    ball.setAttribute("cx", x.toFixed(1));
    ball.setAttribute("cy", y.toFixed(1));
    if (k < 1) return void requestAnimationFrame(step);
    ball.remove();
    landed(svg, fx, to);
  };
  requestAnimationFrame(step);
}
function burstAt(fx: Element, at: { x: number; y: number }, hit: boolean) {
  const boom = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  boom.setAttribute("cx", String(at.x));
  boom.setAttribute("cy", String(at.y));
  boom.setAttribute("r", hit ? "50" : "24");
  boom.setAttribute("class", hit ? "pond-boom" : "pond-splash");
  fx.appendChild(boom);
  setTimeout(() => boom.remove(), 900);
}
function landed(svg: SVGSVGElement, fx: Element, to: { x: number; y: number }) {
  const sayEl = $("#intro-say");
  const hint = (top: number, bottom: number, left: number, right: number) =>
    to.y > bottom ? "Too short: pull further" : to.y < top ? "Too far: pull less" : to.x < left ? "A bit to the left: aim right" : to.x > right ? "A bit to the right: aim left" : "";
  if (introStep === 0) {
    const hit = Math.hypot(to.x - POND.target.x, to.y - POND.target.y) <= POND.target.r + 6;
    burstAt(fx, to, hit);
    if (!hit) {
      sayEl.className = "intro-say";
      const t = POND.target;
      return void (sayEl.textContent = hint(t.y - t.r, t.y + t.r, t.x - t.r, t.x + t.r));
    }
    navigator.vibrate?.(80);
    sayEl.textContent = "💥 BOOM! Nice shot!";
    sayEl.className = "intro-say hit";
    svg.querySelector(".pond-target")!.classList.add("hit");
    ($("#intro-next") as HTMLButtonElement).hidden = false;
    return;
  }
  if (introStep !== 1 || slabsDown >= 2) return;
  const W = POND.wall;
  const inWall = to.x >= W.x && to.x <= W.x + W.w && to.y >= W.y && to.y <= W.y + W.h;
  burstAt(fx, to, inWall);
  if (!inWall) {
    sayEl.className = "intro-say";
    return void (sayEl.textContent = hint(W.y, W.y + W.h, W.x, W.x + W.w));
  }
  const i = (to.x >= W.x + W.w / 2 ? 1 : 0) + (to.y >= W.y + W.h / 2 ? 2 : 0);
  const el = svg.querySelector<SVGRectElement>(`.pond-slab[data-i="${i}"]`);
  if (!el || el.classList.contains("fall")) return void (sayEl.textContent = "That one's already open: hit another!");
  el.classList.add("fall");
  navigator.vibrate?.(60);
  slabsDown++;
  if (slabsDown < 2) {
    sayEl.className = "intro-say hit";
    return void (sayEl.textContent = "💥 One down! Hit another");
  }
  // two hits: the rest crumble and the secret image shows
  setTimeout(() => svg.querySelectorAll(".pond-slab").forEach((s) => s.classList.add("fall")), 350);
  sayEl.className = "intro-say hit";
  sayEl.textContent = "🎉 You revealed the secret image!";
  ($("#intro-next") as HTMLButtonElement).hidden = false;
}

// ───── pirates (the 3 Ship Showdown) ─────
const splatted = new Set<number>();
const piratesLeft = (s: PubState) => PIRATES_EACH - (s.pirates ?? []).filter((x) => x.from === me).length;
const canPirate = (s: PubState) => s.show.stage === "final" && s.show.finalists.includes(me) && s.phase === "open" && piratesLeft(s) > 0;
$("#pirate-btn").addEventListener("click", async () => {
  const s = conn.state;
  if (!s || !canPirate(s)) return;
  const r = await conn.act(KIND.pirate, {});
  if (!r.ok) return say(plain(r.message));
  say(`🏴‍☠️ Pirate away! At ${JSON.parse(r.message.slice(7)).name}`, "hit");
});
function pirates(s: PubState) {
  for (const p of s.pirates ?? []) {
    if (p.to !== me || splatted.has(p.id)) continue;
    splatted.add(p.id);
    if (serverNow() < p.at + PIRATE_FLIGHT_MS + PIRATE_SPLAT_MS) pirateSplat(document.body, s.players[p.from]?.name ?? "a rival", p.at + PIRATE_FLIGHT_MS);
  }
  const finalist = s.show.stage === "final" && s.show.finalists.includes(me) && !s.final;
  const b = $("#pirate-btn") as HTMLButtonElement;
  b.hidden = !finalist;
  b.disabled = !canPirate(s);
  b.textContent = `🏴‍☠️ LAUNCH PIRATE ×${piratesLeft(s)}`;
}

// ───── the cannon: drag back anywhere on the picture, like a slingshot, and let go ─────
let dragging: { x: number; y: number; id: number } | null = null;
let aimShot: { angle: number; power: number } | null = null;
const playing = (s: PubState) => !(s.show.eliminated ?? []).includes(me) && (s.show.stage !== "final" || s.show.finalists.includes(me) || !!s.final?.showOver);
const canFire = () => {
  const s = conn.state;
  if (!s || !s.players[me]) return false;
  if (s.phase === "lobby" || s.phase === "final") return true; // practice
  return s.phase === "open" && playing(s);
};

view.el.addEventListener("pointerdown", (e) => {
  if (!canFire()) return;
  e.preventDefault();
  view.measure(); // one measurement per aim; the moves use it
  dragging = { ...view.toCove(e.clientX, e.clientY), id: e.pointerId };
  aimShot = null;
  view.el.setPointerCapture(e.pointerId);
});
view.el.addEventListener("pointermove", (e) => {
  if (!dragging || e.pointerId !== dragging.id) return;
  const p = view.toCove(e.clientX, e.clientY);
  const vx = dragging.x - p.x;
  const vy = dragging.y - p.y;
  if (Math.hypot(vx, vy) < view.c.h * 0.02) {
    aimShot = null;
    view.aim(null);
    return;
  }
  aimShot = { angle: (Math.atan2(vx, -vy) * 180) / Math.PI, power: Math.min(1, Math.hypot(vx, vy) / (view.c.h * 0.6)) };
  view.aim(aimShot);
});
view.el.addEventListener("pointerup", (e) => {
  if (!dragging || e.pointerId !== dragging.id) return;
  dragging = null;
  const shot = aimShot;
  aimShot = null;
  view.aim(null);
  if (shot && shot.power >= 0.04) void fire(shot.angle, shot.power);
});
view.el.addEventListener("pointercancel", () => {
  dragging = null;
  aimShot = null;
  view.aim(null);
});

// Desktop: ← → turn the cannon, hold Space and let go when the power is right.
let kbAngle = 0;
let charging: number | null = null;
const held = new Set<string>();
document.addEventListener("keydown", (e) => {
  if (document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "range") return;
  const onButton = (e.target as HTMLElement | null)?.closest?.("button, a, select, input");
  if (!onButton && (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight")) e.preventDefault();
  if (!canFire() || onButton) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") held.add(e.key);
  if (e.key === " " && charging === null && !e.repeat) charging = performance.now();
});
document.addEventListener("keyup", (e) => {
  held.delete(e.key);
  if (e.key === " " && charging !== null) {
    e.preventDefault();
    const power = chargePower();
    charging = null;
    view.aim(null);
    void fire(kbAngle, power);
  }
});
function chargePower() {
  if (charging === null) return 0;
  const k = ((performance.now() - charging) / 800) % 2;
  return k < 1 ? k : 2 - k;
}
let lastKeyFrame = performance.now();
function keyLoop(now: number) {
  const dt = (now - lastKeyFrame) / 1000;
  lastKeyFrame = now;
  if (held.has("ArrowLeft")) kbAngle -= 70 * dt;
  if (held.has("ArrowRight")) kbAngle += 70 * dt;
  kbAngle = ((((kbAngle + MAX_ANGLE) % 360) + 360) % 360) - MAX_ANGLE;
  if (charging !== null || held.size) view.aim({ angle: kbAngle, power: chargePower() });
  requestAnimationFrame(keyLoop);
}
requestAnimationFrame(keyLoop);

let sayTimer = 0;
function say(text: string, kind = "") {
  const el = $("#shot-say");
  el.textContent = text;
  el.className = `v2-say show ${kind}`;
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => el.classList.remove("show"), 1600);
}

async function fire(angle: number, power: number) {
  // no words for misses or errors: only the things you hit react (on the scene itself)
  const r = await conn.act(KIND.fire, { angle: Math.round(angle * 10) / 10, power: Math.round(power * 1000) / 1000 });
  if (!r.ok) return;
  lastFire = Date.now();
  if (r.message.startsWith("peek:")) {
    const peek = JSON.parse(r.message.slice(5));
    view.peek(peek.tile, peek);
    navigator.vibrate?.(80);
  }
}

// ───── the dial: the block-height guess ─────
const range = $("#dial-range") as HTMLInputElement;
let dialValue = 0;
let dialGame = "";
function setDial(v: number, s = conn.state) {
  const max = s?.tipHeight ?? 1_000_000;
  dialValue = Math.max(0, Math.min(max, Math.round(v)));
  range.value = String(dialValue);
  $("#dial-num").textContent = fmt(dialValue);
  // the date under the number: training wheels, round 1 only
  $("#dial-date").textContent = !s || datesOn(s) ? `≈ ${monthYear(heightToTime(dialValue))}` : "";
}
range.addEventListener("input", () => setDial(Number(range.value)));
// − and +: a tap moves 1,000 blocks (about a week); hold to keep going, faster and faster
for (const b of document.querySelectorAll<HTMLButtonElement>(".dial-step")) {
  let timer = 0;
  let n = 0;
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
  };
  const step = () => {
    const dir = Number(b.dataset.step) > 0 ? 1 : -1;
    setDial(dialValue + dir * (n > 25 ? 20_000 : n > 10 ? 5_000 : 1_000));
    n++;
    timer = window.setTimeout(step, n === 1 ? 380 : 70);
  };
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (b.disabled) return;
    n = 0;
    step();
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stop);
}
$("#lock").addEventListener("click", async () => {
  const s = conn.state;
  if (!s || s.phase !== "open") return;
  ($("#lock") as HTMLButtonElement).disabled = true;
  const r = await conn.act(KIND.height, { height: dialValue });
  if (!r.ok) {
    ($("#lock") as HTMLButtonElement).disabled = false;
    $("#dial-msg").textContent = plain(r.message);
  } else navigator.vibrate?.(60);
});

// ───── the winner sends the host their Lightning address ─────
$("#claim-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const address = ($("#claim-address") as HTMLInputElement).value.trim();
  if (!address) return;
  const r = await conn.act(KIND.prize, { address });
  $("#claim-msg").textContent = r.ok ? "" : plain(r.message);
});
let prefilled = false;
$("#claim-qr").addEventListener("click", async () => {
  const r = await conn.act(KIND.prize, { qr: true });
  if (!r.ok) return void ($("#claim-msg").textContent = plain(r.message));
  const lnurl = r.message.slice("prizeqr: ".length).trim();
  ($("#claim-qr-img") as HTMLImageElement).src = `/api/qr.svg?text=${encodeURIComponent(`lightning:${lnurl}`)}`;
  ($("#claim-qr-open") as HTMLAnchorElement).href = `lightning:${lnurl}`;
  $("#claim-qr-box").hidden = false;
  $("#claim-msg").textContent = "";
});
function claimBox(s: PubState) {
  const mine = s.final?.stage === "final" ? s.final.ranking.find((r) => r.pk === me && r.share > 0) : undefined;
  $("#claim").hidden = !mine;
  if (!mine) return;
  const sent = (s.claimed ?? []).includes(me);
  const paid = (s.paid ?? []).includes(me);
  $("#claim").classList.toggle("sent", sent);
  const auto = !!s.autoPay;
  // no game wallet: the only way is a Lightning address, and the host pays by hand
  $("#claim-auto").hidden = !auto;
  $("#claim-noaddr").hidden = sent || paid;
  const what = paid
    ? `⚡ <b>Paid!</b> ${fmt(mine.share)} sats are in your wallet. Fair winds, captain!`
    : sent
      ? auto
        ? `⚡ Sending your <b>${fmt(mine.share)} sats</b>… (if your wallet doesn't show it soon, the host will sort it out)`
        : `✓ The host has your Lightning address and will send your <b>${fmt(mine.share)} sats</b> after the show.`
      : auto
        ? `Your prize: <b>${fmt(mine.share)} sats</b>. Scan it with your Lightning wallet, or enter your Lightning address, and the game pays you straight away.`
        : `Your prize: <b>${fmt(mine.share)} sats</b>. Enter your <b>Lightning address</b> below and the host will send it to you.`;
  const html = what + (paid || sent ? brag(`🏆 I won the Bitcoin Ship Show Hardcore Championship Belt! Took the Treasure Tiles 3 Ship Showdown and ${fmt(mine.share)} sats. #bitcoinshipshow`) : "");
  if ($("#claim-what").dataset.html !== html) {
    $("#claim-what").dataset.html = html;
    $("#claim-what").innerHTML = html;
  }
  $("#claim-ways").hidden = sent || paid;
  if (!sent && !prefilled && signer) {
    prefilled = true;
    void myLud16().then((a) => {
      const inp = $("#claim-address") as HTMLInputElement;
      if (a && !inp.value) inp.value = a;
    });
  }
}

// ───── the standings sit beside the wall, never on top of it ─────
function placeStandings() {
  const lb = $("#mini-lb");
  const wall = view.wallRect();
  const box = $("#cove-wrap").getBoundingClientRect();
  if (!wall || !wall.width) return;
  // anchored to the right edge, a compact block; it may never reach back over the wall
  const room = Math.round(box.right - wall.right - 12);
  lb.style.left = "auto";
  lb.style.right = "6px";
  lb.style.width = `${Math.min(240, room)}px`;
  lb.classList.toggle("tight", room < 150);
}
addEventListener("resize", () => requestAnimationFrame(placeStandings));

// ───── drawing ─────
function render(s: PubState) {
  // the treasure, wherever it's mentioned
  for (const el of document.querySelectorAll(".prize-sats")) el.textContent = fmt(s.settings.prizePool);
  document.title = s.settings.title;
  if (!s.players[me] && params.get("name") && !autoJoined) {
    autoJoined = true;
    void conn.act(KIND.join, { name: params.get("name") });
  }
  const p = s.players[me];
  document.body.dataset.screen = !p ? "join" : trainLeft ? "intro" : "game";
  if (!p) return;
  if (trainLeft) {
    buildPond();
    return;
  }
  document.body.style.setProperty("--mine", playerColor(me));
  view.update(s);
  placeStandings();
  // a fresh round: the dial starts in the middle
  if (s.gameId !== dialGame) {
    dialGame = s.gameId;
    range.max = String(s.tipHeight);
    setDial(Math.round(s.tipHeight / 2 / 1000) * 1000, s);
  }
  const between = s.phase === "lobby" || s.phase === "final";
  $("#mini-lb").innerHTML = miniBoard(s, me, between);
  $("#mini-lb").classList.toggle("full", between);
  pirates(s);
  // a round is loaded but not started: tell everyone what's coming
  const ready = s.phase === "lobby";
  if (!ready) $("#wheels-off").hidden = true;
  $("#get-ready").hidden = !ready;
  if (ready) {
    const finalist = s.show.finalists.includes(me);
    const place = s.show.stage === "final"
      ? `<p class="gr-place">${finalist ? "⚔️ Ye made the 3 Ship Showdown! The treasure be within reach!" : "Ye missed the Showdown, matey. Cheer on the captains!"}</p>`
      : "";
    const html = `<small>GET READY FOR</small><b>${esc(upNext(s).toUpperCase())}</b>${place}`;
    // round 2: the dates come off the dial
    $("#wheels-off").hidden = !wheelsOffNow(s);
    if ($("#get-ready").innerHTML !== html) $("#get-ready").innerHTML = html;
  }
  dial(s);
  setDial(dialValue, s);
  result(s);
  claimBox(s);
  tick(s);
}

function dial(s: PubState) {
  const locked = (s.locked ?? []).includes(me);
  const open = s.phase === "open" && playing(s) && serverNow() >= (s.goAt ?? 0);
  $("#dial").hidden = !!s.final;
  $("#dial").classList.toggle("locked", locked);
  // the slider always moves (practice your guess any time); only LOCK IN waits for the round
  range.disabled = locked;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".dial-step")) b.disabled = range.disabled;
  const lock = $("#lock") as HTMLButtonElement;
  lock.disabled = !open || locked;
  lock.textContent = locked ? "🔒 LOCKED IN" : "LOCK IN";
  $("#dial-msg").textContent = !playing(s)
    ? "⚔️ The top 3 are battling in the 3 Ship Showdown: watch the big screen!"
    : locked
    ? `Waiting for the others… (${(s.locked ?? []).length} of ${Object.keys(s.players).length} locked in)`
    : s.phase === "lobby"
      ? "Guessing opens when the round starts"
      : open
        ? "Closer and sooner = more points"
        : "";
}

let splashFor = "";
/** The round is over: a big pop-up with the answer and how close you came. */
function splash(s: PubState) {
  const f = s.final;
  const box = $("#splash");
  // it stays up until the host loads the next round
  if (!f || f.height === undefined) return void (box.hidden = true);
  const showEnd = f.showOver || f.stage === "final";
  // the champion sees their own card (with the prize); everyone else hails them
  if (showEnd && f.ranking[0]?.pk === me) return void (box.hidden = true);
  if (splashFor === s.gameId) return;
  splashFor = s.gameId;
  // don't pop up over a round that ended long before this page opened
  if (serverNow() - (s.deadline || serverNow()) > 60_000 && !f.guesses?.length) return;
  const g = f.guesses?.find((x) => x.pk === me);
  const off = g ? Math.abs(g.off) : 0;
  const of = Object.keys(s.players).filter((pk) => !(s.show.eliminated ?? []).includes(pk)).length;
  const rank = rankOf(s, me);
  const line = g
    ? `You were${off < 144 * 90 ? " only" : ""} off by <b>${fmt(off)} block${off === 1 ? "" : "s"}</b>. <span class="rs-verdict">${esc(guessVerdict(g.off))}</span> <span class="rs-pts">+${g.points} pts</span>`
    : `You didn't lock in a guess this time. <span class="rs-verdict">Don't let it sail by next round!</span>`;
  const champ = showEnd ? f.ranking[0] : undefined;
  if (showEnd) {
    box.innerHTML = `${pirateConfetti(40)}<div class="rs-card rs-champ">
      <img class="rs-belt" src="/badges/belt.png" alt="">
      <div class="rs-kicker">🏆 ALL HAIL THE CHAMPION 🏆</div>
      ${champ ? `<div class="rs-champ-name" style="color:${playerColor(champ.pk)}">${esc(s.players[champ.pk]?.name ?? "")}</div>
      <div class="rs-champ-prize">wins <b>${fmt(champ.share)} sats</b> and the <b>Bitcoin Ship Show Hardcore Championship Belt</b>!</div>` : `<div class="rs-champ-name">Nobody scored!</div>`}
      <div class="rs-champ-answer">${esc(f.event ?? "")}, the block height was <b>${fmt(f.height)}</b>.${g ? ` You were off by ${fmt(off)} blocks.` : ""}</div>
      <div class="rs-place">You finished <b>${ordinal(rank)}</b> of ${of}. Thanks for sailing with us! 🏴‍☠️</div>
      <button type="button" class="rs-close" id="rs-close">Close</button></div>`;
  } else box.innerHTML = `${pirateConfetti(24)}<div class="rs-card">
      <div class="rs-event">${esc(f.event ?? "When it happened")},</div>
      <div class="rs-label">the block height was</div>
      <div class="rs-answer">${fmt(f.height)}</div>
      <div class="rs-you">${line}</div>
      <div class="rs-place">You're in <b>${ordinal(rank)} place</b> of ${of}</div>
      <div class="rs-cheer">${esc(pirateCheer(rank, of))}</div>
      ${f.guesses?.[0]?.pk === me && f.guesses[0].points > 0 ? `<div class="rs-won">🏆 You won the round${signer ? " and a Nostr badge" : ""}!</div>${brag(`🏴‍☠️ I won a round of Treasure Tiles on the Bitcoin Shipshow! ${f.event ?? ""}, I guessed block ${fmt(g!.height)}: only ${fmt(off)} blocks off. #bitcoinshipshow`)}` : ""}
      <button type="button" class="rs-close" id="rs-close">Close</button>
      </div>`;
  // a second to see the revealed picture, then the card, below the wall
  window.setTimeout(() => {
    if (splashFor !== s.gameId || !conn.state?.final) return;
    const wall = view.wallRect();
    box.hidden = false;
    // below the wall if it fits; if not, as low as it can go and still show whole
    const card = box.querySelector<HTMLElement>(".rs-card");
    const h = (card?.offsetHeight ?? 360) + 12;
    const top = Math.min(Math.max(0, wall?.bottom ?? 0) + 6, innerHeight - h);
    box.style.top = `${Math.max(6, Math.round(top))}px`;
  }, 1000);
}

document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "rs-close") $("#splash").hidden = true;
});

function result(s: PubState) {
  splash(s);
  const f = s.final;
  const box = $("#result");
  box.hidden = !f || f.height === undefined;
  if (!f || f.height === undefined) return;
  const g = f.guesses?.find((x) => x.pk === me);
  const mine = g
    ? `<div class="r-you">You: <b>${fmt(g.height)}</b> · ${offText(g.off)} ${g.off === 0 ? "" : g.off < 0 ? "early" : "late"} · <b class="r-pts">+${g.points}</b></div>`
    : `<div class="r-you">You didn't lock in a guess</div>`;
  const rank = rankOf(s, me);
  const html = `<div class="r-label">BLOCK HEIGHT</div>
    <div class="r-answer">${fmt(f.height)}</div>
    <div class="r-date">${f.when ? dayMonthYear(Date.parse(f.when)) : ""}</div>
    ${mine}
    <div class="r-total">${f.showOver ? `Final total: <b>${showPoints(s, me)} pts</b> · #${rank}` : `Total so far: <b>${showPoints(s, me)} pts</b> · #${rank}`}</div>`;
  if (box.innerHTML !== html) box.innerHTML = html;
}

// The last 5 seconds: a big countdown, and at the buzzer whatever the dial shows counts as the guess.
let autoLocked = "";
function lastCall(s: PubState) {
  const el = $("#last-call");
  const msLeft = s.deadline - serverNow();
  const mine = (s.locked ?? []).includes(me);
  const on = s.phase === "open" && playing(s) && !mine && msLeft > 0 && msLeft <= 5000 && serverNow() >= (s.goAt ?? 0);
  el.hidden = !on;
  if (on) {
    const n = String(Math.ceil(msLeft / 1000));
    if (el.dataset.n !== n) {
      el.dataset.n = n;
      el.innerHTML = `<b>${n}</b><span>LOCK IN YOUR ANSWER NOW!</span>`;
      navigator.vibrate?.(40);
    }
  }
  // just before the buzzer: lock in wherever the dial is (once per round)
  if (on && msLeft <= 1300 && autoLocked !== s.gameId) {
    autoLocked = s.gameId;
    void conn.act(KIND.height, { height: dialValue });
  }
}

/** The big round clock, and the score multiplier draining away (answer fast = more points). */
function bigClock(s: PubState) {
  const el = $("#big-clock");
  const mine = (s.locked ?? []).includes(me);
  const on = (s.phase === "open" || s.phase === "paused") && playing(s);
  el.hidden = !on;
  document.body.classList.toggle("in-round", on);
  if (!on) return;
  const now = serverNow();
  const start = s.goAt || now;
  const len = Math.max(1, s.deadline - start);
  const share = Math.max(0, Math.min(1, (s.deadline - Math.max(now, start)) / len));
  const mult = 0.25 + 0.75 * share; // the same speed factor the server scores with
  const left = secondsLeft(s);
  el.classList.toggle("urgent", left <= 10);
  el.classList.toggle("done", mine);
  if (!mine) el.dataset.mult = mult.toFixed(2);
  const shown = mine ? Number(el.dataset.mult || mult) : mult;
  el.innerHTML = `<b>${clockText(left)}</b><div class="bc-mult"><span style="width:${(shown * 100).toFixed(1)}%"></span></div><small>${mine ? "🔒 locked in at" : "score multiplier"} ×${shown.toFixed(2)}</small>`;
}

function tick(s: PubState) {
  const p = s.players[me];
  if (!p) return;
  lastCall(s);
  bigClock(s);
  krakenOverlay($("#kraken"), s, me);
  dial(s); // the LOCK IN button wakes up the moment the countdown ends
  const left = secondsLeft(s);
  const live = ["open", "paused"].includes(s.phase);
  const rank = rankOf(s, me);
  $("#hud").innerHTML = `${live ? `<b class="${s.phase === "open" && left <= 10 ? "urgent" : ""}">${clockText(left)}</b> · ` : ""}${esc(roundLabel(s))} · ${showPoints(s, me)} pts`;
  // the shot recharging: a thin bar on the hud
  const reload = Math.max(0, s.settings.reloadSeconds * 1000 - (Date.now() - lastFire));
  $("#hud").style.setProperty("--reload", `${100 - (reload / Math.max(1, s.settings.reloadSeconds * 1000)) * 100}%`);
  void serverNow;
}
