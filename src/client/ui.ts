// Pieces shared by the board, the players' page, the host page and the lab.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "nostr-tools/utils";
import { PIRATE_FLIGHT_MS, PIRATE_SPLAT_MS, type FeedItem, type Pirate, type PubState, type Shot } from "../shared/types.ts";
import { cove, playerView, playerViewWide, shipAt, type Cove as CoveGeo } from "../shared/cannon.ts";
import { moveProps, propsHtml, reactToShot } from "./scenery.ts";
import { serverNow } from "./net.ts";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
export const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement;
export const fmt = (n: number) => n.toLocaleString("en-US");

export function secondsLeft(s: PubState): number {
  if (s.phase === "paused") return Math.ceil((s.paused?.remaining ?? 0) / 1000);
  if (!s.deadline) return 0;
  // during the countdown the round's clock waits at its full length
  const from = Math.max(serverNow(), s.goAt ?? 0);
  return Math.max(0, Math.ceil((s.deadline - from) / 1000));
}

/** 245 -> "4:05" */
export function clockText(sec: number) {
  return sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : String(sec);
}

/** Does the revealed answer match the hash shown before the game started? */
export function verifySeal(s: PubState): boolean {
  if (!s.final) return false;
  return bytesToHex(sha256(new TextEncoder().encode(`${s.final.salt}|${s.final.answer}`))) === s.commitment;
}

export function toast(msg: string, kind: "info" | "error" | "ok" = "info") {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), 3200);
  setTimeout(() => t.remove(), 3700);
}

/** A steady color per player, from their key. */
export function playerColor(pk: string) {
  let h = 0;
  for (let i = 0; i < 8; i++) h = (h * 31 + pk.charCodeAt(i)) % 360;
  return `hsl(${h} 75% 60%)`;
}

/**
 * Masks for the painted ship sprite (public/art/ship.webp, 500×466): its sails (tinted in the
 * player's color) and its big main sail (where a Nostr profile picture goes).
 */
const SHIP_DEFS = `
  <mask id="sailmask" maskUnits="userSpaceOnUse" x="0" y="0" width="500" height="466"><image href="/art/ship-sails.png" width="500" height="466"/></mask>
  <mask id="mainsailmask" maskUnits="userSpaceOnUse" x="0" y="0" width="500" height="466"><image href="/art/ship-mainsail.png" width="500" height="466"/></mask>`;
// Defined once per page, in an svg that is never hidden: if a copy lived inside something
// hidden (display: none), ships elsewhere on the page would lose their sails' mask and draw
// as solid boxes.
if (typeof document !== "undefined" && !document.getElementById("ship-defs")) {
  const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  holder.id = "ship-defs";
  holder.setAttribute("aria-hidden", "true");
  holder.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  holder.innerHTML = `<defs>${SHIP_DEFS}</defs>`;
  document.body.prepend(holder);
}

export interface ShipLook {
  /** A Nostr profile picture: painted on the main sail. */
  picture?: string;
  /** Whoever is in first flies a gold pennant from the top of the mainmast. */
  leader?: boolean;
}

/**
 * A painted pirate galleon, side on, facing right, drawn around (0,0) at its waterline (the
 * sprite is 500 wide). Its sails are tinted in the player's color; a Nostr picture goes on
 * the main sail; the leader's ship flies a gold "1st" pennant instead of the black flag.
 */
function pennantSvg(leader?: boolean) {
  return leader
    ? `<path class="pennant" d="M236 2 L312 16 L292 28 L312 40 L236 50 Z" fill="#E9C766" stroke="#0B1F33" stroke-width="4"/><text x="252" y="34" font-family="Pirata One, serif" font-size="22" fill="#0B1F33">1st</text>`
    : "";
}

// ── ships baked into one picture each: tinting sails through a stencil every frame, for every
// ship, was the most costly thing on screen. Made once per look, then drawn as a plain image.
const loadImg = (src: string, cors = false) =>
  new Promise<HTMLImageElement>((ok, no) => {
    const im = new Image();
    if (cors) im.crossOrigin = "anonymous";
    im.onload = () => ok(im);
    im.onerror = no;
    im.src = src;
  });
/** A grey stencil (white = keep) as an alpha mask the canvas can use. */
async function stencil(src: string) {
  const im = await loadImg(src);
  const c = document.createElement("canvas");
  c.width = 500;
  c.height = 466;
  const x = c.getContext("2d")!;
  x.drawImage(im, 0, 0, 500, 466);
  const d = x.getImageData(0, 0, 500, 466);
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i + 3] = d.data[i];
    d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
  }
  x.putImageData(d, 0, 0);
  return c;
}
let parts: Promise<[HTMLImageElement, HTMLCanvasElement, HTMLCanvasElement]> | null = null;
const bakedShips = new Map<string, Promise<string | null>>();
export function bakeShip(color: string, picture?: string): Promise<string | null> {
  const key = `${color}|${picture ?? ""}`;
  let p = bakedShips.get(key);
  if (p) return p;
  p = (async () => {
    try {
      parts ??= Promise.all([loadImg("/art/ship.webp"), stencil("/art/ship-sails.png"), stencil("/art/ship-mainsail.png")]);
      const [ship, sails, main] = await parts;
      const layer = (fill: (x: CanvasRenderingContext2D) => void) => {
        const c = document.createElement("canvas");
        c.width = 500;
        c.height = 466;
        fill(c.getContext("2d")!);
        return c;
      };
      const out = layer((x) => x.drawImage(ship, 0, 0));
      const o = out.getContext("2d")!;
      // the sails in the player's colour, multiplied over the painted canvas
      const tint = layer((x) => {
        x.fillStyle = color;
        x.fillRect(0, 0, 500, 466);
        x.globalCompositeOperation = "destination-in";
        x.drawImage(sails, 0, 0);
      });
      o.globalCompositeOperation = "multiply";
      o.drawImage(tint, 0, 0);
      o.globalCompositeOperation = "source-over";
      if (picture) {
        const pic = await loadImg(picture, !picture.startsWith("/"));
        const onSail = layer((x) => {
          // cover the main sail's box (167,227 · 152×104), then keep only the sail's shape
          const s = Math.max(152 / pic.width, 104 / pic.height);
          const w = pic.width * s;
          const h = pic.height * s;
          x.drawImage(pic, 167 + (152 - w) / 2, 227 + (104 - h) / 2, w, h);
          x.globalCompositeOperation = "multiply";
          x.globalAlpha = 0.55;
          x.drawImage(ship, 0, 0);
          x.globalAlpha = 1;
          x.globalCompositeOperation = "destination-in";
          x.drawImage(main, 0, 0);
        });
        o.drawImage(onSail, 0, 0);
      }
      const blob = await new Promise<Blob | null>((ok) => out.toBlob(ok, "image/png"));
      return blob ? URL.createObjectURL(blob) : null;
    } catch {
      return null; // e.g. a Nostr picture from a site that won't share it: keep the live version
    }
  })();
  bakedShips.set(key, p);
  return p;
}
/** A ship drawn from its baked picture (plus the leader's pennant). */
export function bakedShipSvg(url: string, leader?: boolean): string {
  return `<g transform="translate(-250 -440)"><image href="${url}" width="500" height="466"/>${pennantSvg(leader)}</g>`;
}

export function pirateShip(color: string, look: ShipLook = {}) {
  const pic = look.picture
    ? `<g class="pic-flip"><image href="${look.picture.replace(/"/g, "")}" x="167" y="227" width="152" height="104" preserveAspectRatio="xMidYMid slice" mask="url(#mainsailmask)"/>
       <image href="/art/ship.webp" width="500" height="466" mask="url(#mainsailmask)" style="mix-blend-mode:multiply" opacity=".55"/></g>`
    : "";
  const pennant = pennantSvg(look.leader);
  return `<g transform="translate(-250 -440)">
    <image href="/art/ship.webp" width="500" height="466"/>
    <rect width="500" height="466" fill="${color}" mask="url(#sailmask)" style="mix-blend-mode:multiply"/>
    ${pic}${pennant}</g>`;
}

/** A pirate ship as its own little picture, for banners and the winner card. */
export function shipIcon(color: string, cls = "ship", look: ShipLook = {}) {
  return `<svg class="${cls}" viewBox="-255 -445 510 476" aria-hidden="true">${pirateShip(color, look)}</svg>`;
}

/** Points shown for a player: show total so far (prelims), or their points in the final. */
export function showPoints(s: PubState, pk: string) {
  const p = s.players[pk];
  if (!p) return 0;
  if (s.show.stage === "final") return p.points;
  return (s.show.totals[pk] ?? 0) + (s.final ? 0 : p.points);
}

/** Who is in first right now (only once they have points). */
export function leaderOf(s: PubState): string | null {
  let best: string | null = null;
  let top = 0;
  for (const pk of Object.keys(s.players)) {
    if (s.show.stage === "final" && !s.show.finalists.includes(pk)) continue;
    const v = showPoints(s, pk);
    if (v > top) [best, top] = [pk, v];
  }
  return best;
}

// ───────────── the cove: the painted scene, the mural under its slabs, the fleet ─────────────

/** How long a cannonball's flight is drawn (ms) for a shot that reaches the cliff. */
const SHOT_MS = 850;

/** The kraken lottery: the spin runs this long (ms) before the doomed are revealed. */
export const KRAKEN_REVEAL = 6000;
/** With no lottery, the kraken names its victims and strikes after this long (ms). */
export const KRAKEN_STRIKE = 1500;

const NS = "http://www.w3.org/2000/svg";
/** A computer (or tablet) window, not a phone held sideways: the dial is pinned below the cove. */
const WIDE_SCREEN = typeof matchMedia === "function" ? matchMedia("(orientation: landscape) and (min-height: 561px)") : ({ matches: false } as MediaQueryList);
/** On a player's own screen, how many of the other ships to draw. */
const MAX_GHOSTS = 8;
/** Height kept free for the dial pinned at the bottom (px): its real height when it's on the page. */
const dialRoom = () => (document.getElementById("dial")?.offsetHeight || 220) + 8;
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

interface ShipView {
  g: HTMLElement;
  flip: HTMLElement;
  label: HTMLElement;
  slot: number;
  look: string;
  facing: number;
}

/**
 * The scene. On the board it shows the whole fleet sailing the lagoon. On a player's screen
 * (firstPerson) it shows only their own ship (or the finalists', when they're watching the
 * final), zoomed in on the cliff so the picture stays big.
 */
export class Cove {
  readonly el: HTMLDivElement;
  svg!: SVGSVGElement;
  c!: CoveGeo;
  private pieces!: SVGGElement;
  private covers!: SVGGElement;
  private fleet!: HTMLElement;
  private balls!: SVGGElement;
  private aimG!: SVGGElement;
  private picG!: SVGGElement;
  private sign!: SVGGElement;
  private frame!: SVGRectElement;
  private slabClip!: SVGClipPathElement;
  private clipEls = new Map<number, SVGPolygonElement>();
  private revealed = false;
  private lastPirate = -1;
  private gameId = "";
  private shown = new Set<number>();
  private coverEls = new Map<number, SVGPolygonElement>();
  private ships = new Map<string, ShipView>();
  private peeks = new Map<number, SVGElement>();
  private lastShot = -1;
  private aimNow: { angle: number; power: number } | null = null;
  private raf = 0;
  private view = { x: 0, y: 0, w: 0, h: 0 };
  /** Screen pixels per scene unit, and where the scene sits: measured when the box changes, never per frame. */
  private px = 1;
  private rect = { left: 0, top: 0, width: 1, height: 1 };
  private sizeWatch = new ResizeObserver(() => this.measure());
  /** Re-measure the scene's place on screen (on resize, and when an aim starts). */
  measure() {
    const r = this.el.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top, width: r.width || 1, height: r.height || 1 };
    if (this.view.w) this.px = this.rect.width / this.view.w;
  }
  /** Scene units per picture pixel. */
  private k = 1;

  private last: PubState | null = null;

  constructor(parent: HTMLElement, private opts: { me?: string; firstPerson?: boolean } = {}) {
    this.el = document.createElement("div");
    this.el.className = `cove ${opts.firstPerson ? "first-person" : ""}`;
    parent.appendChild(this.el);
    // turning the phone changes how much of the cove fits: redraw with the new view
    if (opts.firstPerson) {
      const redraw = () => {
        if (!this.last) return;
        this.gameId = "";
        this.update(this.last);
      };
      matchMedia("(orientation: landscape)").addEventListener("change", redraw);
      // a computer's window: the view follows its shape (debounced while dragging the edge)
      let t = 0;
      addEventListener("resize", () => {
        if (!WIDE_SCREEN.matches) return;
        clearTimeout(t);
        t = window.setTimeout(redraw, 200);
      });
    }
  }

  /**
   * A computer's window: always the full height from the cliff top to the lagoon's near edge,
   * and as much of the cove's width as the window's shape calls for (more town in a wide window).
   */
  private windowView(c: CoveGeo) {
    // from the cliff just left of the wall, across the wall, to the town; down to just past the ships
    const y = 40;
    const h = 740;
    const room = Math.max(240, innerHeight - dialRoom());
    const w = Math.round(Math.min(c.w, Math.max(820, h * (innerWidth / room))));
    const x = Math.round(Math.min(c.w - w, Math.max(0, c.pic.x - 0.1 * w)));
    return { x, y, w, h };
  }

  private build(s: PubState) {
    this.gameId = s.gameId;
    this.shown.clear();
    this.coverEls.clear();
    this.clipEls.clear();
    this.ships.clear();
    this.peeks.clear();
    const c = (this.c = cove(s.image.w, s.image.h));
    const { pic } = c;
    this.k = pic.w / s.image.w;
    // A player's screen in portrait zooms in on the cliff and lagoon; in landscape there's room
    // for the whole cove, town and all.
    const sideways = matchMedia("(orientation: landscape)").matches;
    const vb = (this.view = !this.opts.firstPerson ? { x: 0, y: 0, w: c.w, h: c.h } : WIDE_SCREEN.matches ? this.windowView(c) : sideways ? playerViewWide(c) : playerView(c));
    // a computer: as wide as the window, never taller than what's left above the dial
    if (this.opts.firstPerson && WIDE_SCREEN.matches) {
      const room = Math.max(240, innerHeight - dialRoom());
      this.el.style.width = `${Math.min(innerWidth, Math.round(room * (vb.w / vb.h)))}px`;
    } else this.el.style.width = "";
    this.el.style.setProperty("--ar", String(vb.w / vb.h));
    this.el.innerHTML = "";
    // The cove loops a short video (the town partying, the water shimmering) behind everything;
    // the still painting shows until it plays, and if it can't. It's cropped to the same view.
    const video = document.createElement("video");
    Object.assign(video, { src: "/art/cove-loop.mp4", poster: "/art/cove.jpg", muted: true, loop: true, autoplay: true, playsInline: true });
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.className = "cove-loop";
    Object.assign(video.style, { width: `${(c.w / vb.w) * 100}%`, height: `${(c.h / vb.h) * 100}%`, left: `${(-vb.x / vb.w) * 100}%`, top: `${(-vb.y / vb.h) * 100}%` });
    this.el.appendChild(video);
    void video.play().catch(() => {});
    this.svg = svgEl("svg", { viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`, preserveAspectRatio: "xMidYMid slice" });
    this.svg.innerHTML = `<defs>
        <pattern id="rock" patternUnits="userSpaceOnUse" width="420" height="420"><image href="/art/rock.jpg" width="420" height="420"/></pattern>
        <clipPath id="picclip"><rect width="${s.image.w}" height="${s.image.h}"/></clipPath>
        <!-- the slabs are painted as one big red-and-white bullseye: the target -->
        <radialGradient id="bullseye" gradientUnits="userSpaceOnUse" cx="${s.image.w / 2}" cy="${s.image.h / 2}" r="${Math.max(s.image.w, s.image.h) / 7}" spreadMethod="repeat">
          <stop offset="0" stop-color="#e3262f"/><stop offset=".5" stop-color="#e3262f"/><stop offset=".5" stop-color="#fff3df"/><stop offset="1" stop-color="#fff3df"/>
        </radialGradient>
        <!-- the bullseye painted onto the rock: the cliff's texture shows through the paint -->
        <pattern id="paintedrock" patternUnits="userSpaceOnUse" width="${s.image.w}" height="${s.image.h}">
          <rect width="${s.image.w}" height="${s.image.h}" fill="url(#bullseye)"/>
          <rect width="${s.image.w}" height="${s.image.h}" fill="url(#rock)" opacity=".34"/>
        </pattern>
        <filter id="muralshadow" x="-5%" y="-5%" width="110%" height="110%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-opacity=".45"/></filter>
        <!-- a soft gold outline around everything a cannonball can hit (besides the slabs) -->
        <filter id="goldglow" x="-25%" y="-25%" width="150%" height="150%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="3" result="fat"/>
          <feGaussianBlur in="fat" stdDeviation="4" result="soft"/>
          <feFlood flood-color="#ffd35c" flood-opacity=".9"/>
          <feComposite in2="soft" operator="in" result="glow"/>
          <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      `;
    const picG = (this.picG = svgEl("g", { class: "mural", transform: `translate(${pic.x} ${pic.y}) scale(${this.k})`, filter: "url(#muralshadow)" }));
    this.revealed = false;
    this.pieces = svgEl("g", { "clip-path": "url(#picclip)" });
    this.covers = svgEl("g", { class: "covers" });
    // a thick gold frame, and the sign telling everyone what to do
    const frame = (this.frame = svgEl("rect", { class: "wall-frame", x: -12 / this.k, y: -12 / this.k, width: s.image.w + 24 / this.k, height: s.image.h + 24 / this.k, "stroke-width": 16 / this.k }));
    // the words are painted on the slabs themselves: clipped to the slabs still up, so each
    // slab that falls takes its piece of the lettering with it and never covers the picture
    this.slabClip = svgEl("clipPath", { id: "slabclip" });
    this.sign = svgEl("g", { class: "wall-sign", "clip-path": "url(#slabclip)" });
    const sh = s.image.h * 0.22;
    const top = s.image.h / 2 - sh / 2;
    this.sign.innerHTML = `<g transform="rotate(-4 ${s.image.w / 2} ${s.image.h / 2})">
      <text class="s1" x="${s.image.w / 2}" y="${top + sh * 0.44}" text-anchor="middle" font-size="${sh * 0.42}">SHOOT THE WALL</text>
      <text class="s2" x="${s.image.w / 2}" y="${top + sh * 0.84}" text-anchor="middle" font-size="${sh * 0.24}"></text></g>`;
    this.svg.querySelector("defs")!.appendChild(this.slabClip);
    picG.append(this.pieces, this.covers, this.sign, frame);
    // scenery that stands still lives in the cached back layer; only the travellers move up top
    // the "actors" layer: scenery and ships as little graphics-card layers, all in one depth
    // order (whichever bottom edge is lower is in front); nothing here redraws the scene
    const sceneryStill = document.createElement("div");
    sceneryStill.className = "props-html fleet";
    sceneryStill.innerHTML = propsHtml(vb);
    this.fleet = sceneryStill;

    this.balls = svgEl("g", { class: "balls" });
    this.aimG = svgEl("g", { class: "aim" });
    // the back cliff, built up taller (the painting's own rock) so the big wall sits on cliff, not jungle
    const cliff = svgEl("image", { href: "/art/cliff-extend.webp", x: 360, y: 0, width: 980, height: 610, class: "cliff-extend" });
    // Two layers: the wall (slabs, lettering, picture pieces: costly to draw) sits in a back layer
    // that only redraws when a slab falls; everything that moves every frame is in the layer above.
    const base = svgEl("svg", { viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`, preserveAspectRatio: "xMidYMid slice", class: "cove-base" });
    base.append(this.svg.querySelector("defs")!, cliff, picG);
    this.svg.append(this.balls, this.aimG);
    this.el.append(base, sceneryStill, this.svg);
    this.sizeWatch.disconnect();
    this.sizeWatch.observe(this.el);
    this.measure();
    s.tiles.forEach((t, i) => {
      if (t.img) return void this.addPiece(t.img);
      const p = svgEl("polygon", { points: t.points, class: "slab" });
      this.covers.appendChild(p);
      this.coverEls.set(i, p);
      const cp = svgEl("polygon", { points: t.points });
      this.slabClip.appendChild(cp);
      this.clipEls.set(i, cp);
    });
    // Don't replay shots that happened before this page opened.
    this.lastShot = Math.max(-1, ...s.shots.map((x) => x.id));
    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.sail();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private addPiece(img: { url: string; x: number; y: number; w: number; h: number }, cls = "") {
    const im = svgEl("image", { href: img.url, x: img.x, y: img.y, width: img.w, height: img.h, class: cls });
    this.pieces.appendChild(im);
    return im;
  }

  private targetBackAt = 0;

  update(s: PubState) {
    this.last = s;
    this.targetBackAt = s.targetBackAt ?? 0;
    if (s.gameId !== this.gameId) this.build(s);
    let n = 0;
    s.tiles.forEach((t, i) => {
      if (!t.img || this.shown.has(i)) return;
      this.shown.add(i);
      this.peeks.get(i)?.remove();
      this.peeks.delete(i);
      this.addPiece(t.img);
      const slab = this.coverEls.get(i);
      if (!slab) return;
      this.coverEls.delete(i);
      this.clipEls.get(i)?.remove();
      this.clipEls.delete(i);
      // The slab breaks off the cliff: a little hop, a spin, and down into the lagoon.
      const delay = s.phase === "final" ? n++ * 35 : 0;
      slab.style.setProperty("--dx", `${(Math.random() - 0.5) * 500}px`);
      slab.style.setProperty("--r", `${(Math.random() - 0.5) * 80}deg`);
      slab.style.animationDelay = `${delay}ms`;
      slab.classList.add("fall");
      this.covers.appendChild(slab);
      setTimeout(() => slab.remove(), 1700 + delay);
    });
    // "shoot the wall": while the round is young (or for practice before it starts)
    const open = s.tiles.filter((t) => t.img).length / Math.max(1, s.tiles.length);
    const say = s.phase === "lobby" ? "PRACTICE SHOTS" : s.phase === "open" && open < 0.5 ? "TO REVEAL THE CLUE" : "";
    const label = this.sign.querySelector(".s2")!;
    if (label.textContent !== say) label.textContent = say;
    this.sign.classList.toggle("on", !!say);
    this.syncFleet(s);
    if (s.final?.revealUrl && !this.revealed) this.reveal(s.final.revealUrl, s.image, Math.min(2500, 600 + n * 35));
    for (const p of s.pirates ?? []) {
      if (p.id <= this.lastPirate) continue;
      this.lastPirate = p.id;
      this.flyPirate(p);
    }
    for (const shot of s.shots ?? []) {
      if (shot.id <= this.lastShot) continue;
      this.lastShot = shot.id;
      // a player's screen only animates their own cannon; the other ships are quiet ghosts
      if (this.opts.firstPerson && shot.pk !== this.opts.me) continue;
      this.animateShot(shot);
    }
  }

  private syncFleet(s: PubState) {
    const final = s.show.stage === "final";
    const gone = new Set(s.show.eliminated ?? []);
    // during the kraken the doomed are still afloat (it's about to drag them under)
    const doomed = new Set(s.phase === "kraken" ? (s.kraken?.doomed ?? []) : []);
    const afloat = (pk: string) => (!gone.has(pk) || doomed.has(pk)) && (!final || s.show.finalists.includes(pk));
    const me = this.opts.me ?? "";
    // Board: every ship afloat. A player's screen: everyone afloat too, but the others are
    // translucent ghost ships so their own stands out.
    // A player's screen draws at most MAX_GHOSTS of the other ships (every ship costs a little
    // each frame; with 25 players they'd be a pile anyway). The board draws the whole fleet.
    let want = Object.entries(s.players).filter(([pk]) => afloat(pk));
    if (this.opts.firstPerson) {
      const others = want.filter(([pk]) => pk !== me).sort((a, b) => ((a[1].slot * 7919) % 101) - ((b[1].slot * 7919) % 101)).slice(0, MAX_GHOSTS);
      want = [...want.filter(([pk]) => pk === me), ...others];
    }
    const keep = new Set(want.map(([pk]) => pk));
    // a big fleet on the board: names would pile up unreadably (the standings list has them)
    this.fleet.classList.toggle("crowd", !this.opts.firstPerson && want.length > 8);
    for (const [pk, v] of this.ships) if (!keep.has(pk)) (v.g.remove(), this.ships.delete(pk));
    const leader = leaderOf(s);
    for (const [pk, p] of want) {
      const look = { picture: p.picture, leader: pk === leader };
      const key = JSON.stringify(look);
      let v = this.ships.get(pk);
      const ghost = !!this.opts.firstPerson && pk !== me;
      if (!v) {
        const g = document.createElement("div");
        g.className = `boat ${pk === me ? "mine" : ""} ${ghost ? "ghost" : ""}`;
        const bob = document.createElement("div");
        bob.className = "bob";
        const flip = document.createElement("div");
        flip.className = "flip";
        bob.appendChild(flip);
        const label = document.createElement("div");
        label.className = "boat-name";
        g.append(bob, label);
        this.fleet.appendChild(g);
        v = { g, flip, label, slot: p.slot, look: "", facing: 0 };
        this.ships.set(pk, v);
      }
      if (v.look !== key) {
        // ghost ships are plain and faded: no sail tint masks to redraw
        // ghosts: a plain faded picture; others: the live drawing until the baked picture is ready
        v.flip.innerHTML = ghost ? `<img src="/art/ship-ghost.webp" alt="">` : `<svg viewBox="-250 -440 500 466">${pirateShip(playerColor(pk), look)}</svg>`;
        if (!ghost) {
          const want = key;
          const flip = v.flip;
          const view = v;
          void bakeShip(playerColor(pk), p.picture).then((url) => {
            if (url && view.look === want) flip.innerHTML = `<img src="${url}" alt="">${look.leader ? `<svg class="pennant-svg" viewBox="0 0 500 466">${pennantSvg(true)}</svg>` : ""}`;
          });
        }
        v.look = key;
        v.facing = 0;
      }
      v.slot = p.slot;
      v.g.classList.toggle("leader", pk === leader);
      v.label.textContent = ghost || (this.opts.firstPerson && pk === me) ? "" : p.name;
    }
    this.kraken(s);
  }

  /** The kraken's meal: a tentacle rises beside each doomed ship and drags it under. */
  private krakenAt = 0;
  private kraken(s: PubState) {
    const k = s.phase === "kraken" ? s.kraken : undefined;
    if (!k || this.krakenAt === k.at) return;
    this.krakenAt = k.at;
    const grabAt = k.at + (k.lottery === false ? KRAKEN_STRIKE : KRAKEN_REVEAL); // after the lottery spin, if any
    const wait = Math.max(0, grabAt - serverNow());
    setTimeout(() => {
      k.doomed.forEach((pk, i) => {
        const v = this.ships.get(pk);
        if (!v) return;
        setTimeout(() => {
          const p = shipAt(v.slot, serverNow() / 1000, this.c);
          const arm = svgEl("image", { href: "/art/kraken.webp", x: p.x - 110, y: p.y - 150, width: 220, height: 216, class: "kraken-grab" });
          this.balls.appendChild(arm);
          v.g.classList.add("sinking");
          setTimeout(() => arm.remove(), 3200);
        }, i * 450);
      });
    }, wait);
  }

  /** Every frame: move each ship along its course (the same course the server uses). */
  private sail() {
    if (!this.c) return;
    const t = serverNow() / 1000;
    moveProps(this.el, t, this.px);
    const base = this.opts.firstPerson && this.view.w < this.c.w ? 0.33 : this.opts.firstPerson ? 0.3 : 0.27;
    const px = this.px;
    for (const [pk, v] of this.ships) {
      const p = shipAt(v.slot, t, this.c);
      const k = base * p.scale;
      const ph = v.slot * 0.9;
      const bob = Math.sin(t * 2.1 + ph) * 7;
      const roll = Math.sin(t * 1.7 + ph) * 2;
      // each ship is its own layer: moving it is a transform the graphics card does
      v.g.style.transform = `translate3d(${((p.x - this.view.x) * px).toFixed(1)}px, ${((p.y + bob * k - this.view.y) * px).toFixed(1)}px, 0) scale(${(k * px).toFixed(4)}) rotate(${roll.toFixed(2)}deg) translate(-250px, -440px)`;
      // depth: whichever bottom edge is lower (nearer the viewer) is in front, ships and scenery alike
      v.g.style.zIndex = String(Math.round(p.y));
      if (v.facing !== p.facing) {
        v.facing = p.facing;
        v.flip.style.transform = p.facing < 0 ? "scaleX(-1)" : "";
      }
      if (pk === this.opts.me && this.aimNow) this.drawAim(p);
    }
  }

  private animateShot(shot: Shot) {
    const ship = this.ships.get(shot.pk);
    if (ship) {
      ship.g.classList.remove("firing");
      requestAnimationFrame(() => ship.g.classList.add("firing"));
      setTimeout(() => ship.g.classList.remove("firing"), 2500);
    }
    const from = { x: shot.from.x, y: shot.from.y - 60 };
    const to = shot.to;
    const ball = svgEl("circle", { class: "ball" });
    const flash = svgEl("circle", { class: "muzzle", cx: from.x, cy: from.y, r: 26 });
    this.balls.append(flash, ball);
    setTimeout(() => flash.remove(), 400);
    const peak = Math.min(from.y, to.y) - (shot.result === "short" ? 60 : 150);
    const dur = shot.result === "short" ? 650 : SHOT_MS;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const mx = (from.x + to.x) / 2;
      const x = (1 - k) * (1 - k) * from.x + 2 * (1 - k) * k * mx + k * k * to.x;
      const y = (1 - k) * (1 - k) * from.y + 2 * (1 - k) * k * peak + k * k * to.y;
      ball.setAttribute("cx", x.toFixed(1));
      ball.setAttribute("cy", y.toFixed(1));
      ball.setAttribute("r", (13 * (1 - k * 0.45)).toFixed(1));
      if (k < 1) return void requestAnimationFrame(step);
      ball.remove();
      this.impact(shot.result, to, shot.practice, (shot.at + dur) / 1000);
    };
    requestAnimationFrame(step);
  }

  private impact(result: Shot["result"], at: { x: number; y: number }, practice = false, when = serverNow() / 1000) {
    const fx = svgEl("g", { class: `fx fx-${result}`, transform: `translate(${at.x} ${at.y})` });
    const r = 46;
    const words: Record<string, string> = { short: "plop", wide: "splash", over: "whoosh", rock: practice ? "ping" : "clank", town: "crash", rubble: "thud", hit: "BOOM", letter: "CAW! A LETTER!" };
    if (result === "short" || result === "wide") fx.innerHTML = `<ellipse rx="${r}" ry="${r * 0.3}" class="ring"/><ellipse rx="${r * 0.5}" ry="${r * 0.15}" class="ring r2"/>`;
    else if (result === "hit" || result === "letter") fx.innerHTML = `<circle r="${r}" class="boom"/>`;
    else if (result !== "over") fx.innerHTML = `<circle r="${r * 0.55}" class="puff"/>`;
    fx.innerHTML += `<text y="${result === "over" ? r : -r * 0.5}" text-anchor="middle" class="fx-word ${result === "hit" || result === "letter" ? "hit" : ""}">${words[result]}</text>`;
    this.balls.appendChild(fx);
    setTimeout(() => fx.remove(), 1300);
    reactToShot(this.el, this.svg, at.x, at.y, when, (x, y, word) => {
      const t = svgEl("text", { x, y, class: "prop-say", "text-anchor": "middle" });
      t.textContent = word;
      this.balls.appendChild(t);
      setTimeout(() => t.remove(), 1800);
    });
  }

  /**
   * The glorious reveal: once the last slabs have tumbled, the finished picture (with its
   * title) fades in over the mural with a flash of gold.
   */
  private reveal(url: string, size: { w: number; h: number }, delay: number) {
    this.revealed = true;
    const g = svgEl("g", { class: "reveal" });
    g.innerHTML = `<image href="${url.replace(/"/g, "")}" width="${size.w}" height="${size.h}"/><rect class="reveal-flash" width="${size.w}" height="${size.h}"/>`;
    // after the last slabs have tumbled
    g.style.animationDelay = `${delay}ms`;
    g.querySelector(".reveal-flash")!.setAttribute("style", `animation-delay:${delay}ms`);
    this.picG.insertBefore(g, this.covers);
  }

  /**
   * A pirate flung from one ship at another: it spins along a big arc, lands with a splat and
   * clings to the ship, then slides off into the lagoon. (The victim's own screen gets the
   * full face-full; see pirateSplat.)
   */
  private flyPirate(p: Pirate) {
    const from = this.ships.get(p.from);
    const to = this.ships.get(p.to);
    const land = p.at + PIRATE_FLIGHT_MS;
    if (!from || !to || !this.c || serverNow() > land + PIRATE_SPLAT_MS) return;
    from.g.classList.remove("firing");
    requestAnimationFrame(() => from.g.classList.add("firing"));
    setTimeout(() => from.g.classList.remove("firing"), 2500);
    const a = shipAt(from.slot, p.at / 1000, this.c);
    const body = svgEl("image", { href: "/art/pirate-fly.webp", width: 120, height: 122, x: -60, y: -61, class: "flying-pirate" });
    const spin = svgEl("g");
    spin.appendChild(body);
    this.balls.appendChild(spin);
    const step = () => {
      const now = serverNow();
      const k = Math.max(0, Math.min(1, (now - p.at) / PIRATE_FLIGHT_MS));
      const b = shipAt(to.slot, Math.min(now, land) / 1000, this.c);
      const sx = a.x;
      const sy = a.y - 120;
      const ex = b.x;
      const ey = b.y - 80;
      const peak = Math.min(sy, ey) - 380;
      const x = (1 - k) * (1 - k) * sx + 2 * (1 - k) * k * ((sx + ex) / 2) + k * k * ex;
      const y = (1 - k) * (1 - k) * sy + 2 * (1 - k) * k * peak + k * k * ey;
      spin.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(k * 900 * (ex >= sx ? 1 : -1)).toFixed(0)}) scale(${(0.8 + 0.5 * Math.sin(k * Math.PI)).toFixed(2)})`);
      if (k < 1) return void requestAnimationFrame(step);
      spin.remove();
      // splat: it clings to the ship (so it sails along with it), then slides off
      const stuck = document.createElement("div");
      stuck.className = "pirate-stuck";
      stuck.innerHTML = `<img src="/art/pirate-splat.webp" alt=""><b class="pirate-splat-word">SPLAT!</b>`;
      to.g.appendChild(stuck);
      setTimeout(() => stuck.classList.add("slide"), Math.max(0, land + PIRATE_SPLAT_MS - serverNow()));
      setTimeout(() => stuck.remove(), Math.max(0, land + PIRATE_SPLAT_MS - serverNow()) + 1200);
    };
    requestAnimationFrame(step);
  }

  /** Only on the shooter's page: the piece they hit, before everyone else sees it. */
  peek(tile: number, img: { url: string; x: number; y: number; w: number; h: number }) {
    if (this.shown.has(tile) || this.peeks.has(tile)) return;
    // wait for the ball to land (the flight animation runs SHOT_MS), then open the window
    this.peeks.set(tile, svgEl("g"));
    setTimeout(() => {
      if (this.shown.has(tile) || !this.peeks.has(tile)) return;
      this.peeks.get(tile)?.remove();
      this.peeks.set(tile, this.addPiece(img, "peeking"));
      this.coverEls.get(tile)?.classList.add("see-through");
    }, SHOT_MS);
  }

  /** The aiming arrow from my ship; null hides it. */
  aim(a: { angle: number; power: number } | null) {
    this.aimNow = a;
    if (!a) this.aimG.innerHTML = "";
  }

  private drawAim(p: { x: number; y: number }) {
    const a = this.aimNow!;
    const len = 90 + a.power * 330;
    const rad = (a.angle * Math.PI) / 180;
    const x1 = p.x;
    const y1 = p.y - 70;
    const x2 = x1 + Math.sin(rad) * len;
    const y2 = y1 - Math.cos(rad) * len;
    const hue = 120 - a.power * 120;
    this.aimG.innerHTML = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="hsl(${hue} 90% 55%)" stroke-width="12" stroke-linecap="round" stroke-dasharray="18 14"/><circle cx="${x2}" cy="${y2}" r="18" fill="hsl(${hue} 90% 55%)" stroke="#0B1F33" stroke-width="4"/>`;
  }

  /** Where the wall (with its frame) is on screen. */
  wallRect() {
    return this.frame?.getBoundingClientRect();
  }

  /** Screen point → cove coordinates (from the box measured when the aim started). */
  toCove(clientX: number, clientY: number) {
    const r = this.rect;
    return { x: this.view.x + ((clientX - r.left) / r.width) * this.view.w, y: this.view.y + ((clientY - r.top) / r.height) * this.view.h };
  }

}

// ───────────── the phrase, Wheel of Fortune style ─────────────

export class PhraseBoard {
  private known = new Set<number>();
  private gameId = "";

  constructor(readonly el: HTMLElement, private showFinders = true) {
    el.classList.add("phrase");
  }

  /** Letters only this page may see (won from the bottle), until they go public. */
  mine: { word: number; pos: number; ch: string; until: number }[] = [];

  update(s: PubState) {
    if (s.gameId !== this.gameId) {
      this.gameId = s.gameId;
      this.mine = [];
      this.known = new Set(s.words.map((w, i) => (w.text && !w.given ? i : -1)).filter((i) => i >= 0));
    }
    this.mine = this.mine.filter((m) => m.until > serverNow());
    const peeking = new Map((s.letterPeeks ?? []).map((lp) => [`${lp.word}:${lp.pos}`, lp.pk]));
    const label = `<div class="phrase-label">Secret phrase${s.hint ? ` <span class="phrase-hint">Hint: ${esc(s.hint)}</span>` : ""}</div>`;
    this.el.innerHTML = label + s.words
      .map((w, i) => {
        const fresh = !!w.text && !w.given && !this.known.has(i);
        if (w.text && !w.given) this.known.add(i);
        const color = w.foundBy ? playerColor(w.foundBy) : "";
        const cells = Array.from({ length: w.len }, (_, k) => {
          const own = !w.text ? this.mine.find((m) => m.word === i && m.pos === k) : undefined;
          const ch = w.text ? w.text[k] : (w.letters[k] ?? own?.ch);
          const peeker = !w.text && !w.letters[k] ? peeking.get(`${i}:${k}`) : undefined;
          const cls = w.given ? "given" : w.text ? "found" : own ? "secret" : ch ? "shown" : peeker ? "peek" : "blank";
          const style = `${fresh ? `animation-delay:${k * 60}ms;` : ""}${peeker || own ? `--who:${playerColor(peeker ?? "")}` : ""}`;
          return `<span class="cell ${cls}" style="${style}">${esc(ch ?? (peeker ? "?" : ""))}</span>`;
        }).join("");
        const who = this.showFinders && w.foundBy && s.players[w.foundBy] ? `<span class="finder" style="color:${color}">${esc(s.players[w.foundBy].name)}</span>` : "";
        return `<span class="word ${w.given ? "is-given" : w.text ? "is-found" : "is-hidden"} ${fresh ? "fresh" : ""}" style="${color ? `--who:${color}` : ""}"><span class="cells">${cells}</span>${who}</span>`;
      })
      .join("");
  }
}

// ───────────── feed, leaderboard ─────────────

export function feedItem(f: FeedItem, s: PubState) {
  if (f.kind === "clue") return `<li class="f-clue">📜 <b>New clue:</b> ${esc(f.text)}</li>`;
  const p = s.players[f.pk];
  const name = `<b style="color:${playerColor(f.pk)}">${esc(p?.name ?? "Someone")}</b>`;
  if (f.hidden) return `<li class="f-miss">${name} <span class="muted">(guess hidden)</span></li>`;
  if (f.kind === "miss") return `<li class="f-miss">${name} <span class="g">${esc(f.text.toUpperCase())}</span> <span class="x">✗</span></li>`;
  return `<li class="f-hit">${name} <span class="g">${esc((f.words ?? []).join(" "))}</span> <span class="plus">+${f.points}</span>${f.kind === "solve" ? " 🏆" : ""}</li>`;
}

export function phaseLine(s: PubState): string {
  if (s.phase === "kraken") return "🐙 The kraken stirs…";
  if (s.phase === "lobby") return "Now boarding";
  if (s.phase === "paused") return "⏸ Paused";
  if (s.phase === "final") return "Land ho!";
  return "Fire away and guess!";
}

function ranked(s: PubState) {
  const final = s.show.stage === "final";
  const gone = new Set(s.show.eliminated ?? []);
  return Object.entries(s.players)
    .filter(([pk]) => !final || s.show.finalists.includes(pk))
    .map(([pk, p]) => [pk, p, showPoints(s, pk)] as const)
    .sort((a, b) => Number(gone.has(a[0])) - Number(gone.has(b[0])) || b[2] - a[2] || a[1].slot - b[1].slot);
}

/** The top scorers (and you, if you're further down). Prelims: show totals. Final: finalists. */
export function leaderboard(s: PubState, me = "", n = 6) {
  const all = ranked(s);
  const rows = all.slice(0, n);
  const myRank = all.findIndex(([pk]) => pk === me);
  if (me && myRank >= n) rows.push(all[myRank]);
  return rows
    .map(([pk, p, pts]) => {
      const rank = all.findIndex(([k]) => k === pk) + 1;
      const acc = p.shots ? `🎯 ${p.hits}/${p.shots}` : "";
      const gone = (s.show.eliminated ?? []).includes(pk);
      return `<div class="lb-row ${pk === me ? "mine" : ""} ${gone ? "gone" : ""}" style="--who:${playerColor(pk)}"><span class="lb-rank">${gone ? "☠️" : rank}</span><span class="lb-name">${esc(p.name)}</span><span class="lb-meta">${acc}</span><span class="lb-pts">${pts}</span></div>`;
    })
    .join("");
}

/**
 * The leaderboard that sits over the right side of a player's game screen. During a round: the
 * top 3 and "you: #7 of 18". Between rounds (full): everyone.
 */
export function miniBoard(s: PubState, me: string, full: boolean, folded = false) {
  const all = ranked(s);
  if (!all.length) return "";
  const gone = new Set(s.show.eliminated ?? []);
  const row = ([pk, p, pts]: (typeof all)[number], i: number) =>
    `<div class="mlb-row ${pk === me ? "mine" : ""} ${gone.has(pk) ? "gone" : ""}" style="--who:${playerColor(pk)}"><span>${gone.has(pk) ? "☠️" : i + 1}</span><b>${esc(p.name)}</b><span>${pts}</span></div>`;
  const rows = (full && !folded ? all : all.slice(0, 3)).map(row).join("");
  const mine = all.findIndex(([pk]) => pk === me);
  const you = mine >= 0 ? `<div class="mlb-you">You: <b>#${mine + 1}</b> of ${all.length}</div>` : "";
  return `<div class="mlb-head">🏆 Standings</div>${rows}${you}`;
}

export function rankOf(s: PubState, me: string) {
  return ranked(s).findIndex(([pk]) => pk === me) + 1;
}

/** "Round 2", "The final" */
export function roundLabel(s: PubState) {
  if (s.show.stage === "final" && !s.final?.showOver) return "⚔️ 3 Ship Showdown";
  return s.show.prelimTotal ? `Round ${s.show.round} of ${s.show.prelimTotal}` : `Round ${s.show.round}`;
}

export function windText(w: number) {
  if (Math.abs(w) < 0.08) return "calm";
  return (w > 0 ? "→" : "←").repeat(Math.max(1, Math.round(Math.abs(w) * 3)));
}

export function pirateConfetti(n = 36) {
  const bits = ["🪙", "🏴‍☠️", "⚓", "🦜", "💰", "☠️", "🪙", "🗺️", "⚡", "🪙"];
  return `<div class="confetti" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i style="left:${(i * 37) % 100}%;animation-delay:${((i * 0.17) % 1.6).toFixed(2)}s;font-size:${1 + ((i * 7) % 5) / 5}em">${bits[i % bits.length]}</i>`).join("")}</div>`;
}

/**
 * The kraken lottery, shown over the cove: the bottom third's names spin, then the doomed are
 * revealed and dragged under. Call often (it animates from the server clock).
 */
const MUMBLES = ["mrrbl… rum…", "where'm I…", "arrrgh…", "hic!", "nice boat ye got…", "blrbl blrbl", "is this… the poop deck?", "mmmf… me hat…", "yarr… zzz…"];

/**
 * On the victim's own screen: a pirate splatted across it, drooling and mumbling, for
 * PIRATE_SPLAT_MS; then it slides down and off. Taps go straight through it (you can still
 * fire blind, if you're brave).
 */
export function pirateSplat(box: HTMLElement, from: string, landAt: number) {
  const wait = Math.max(0, landAt - serverNow());
  setTimeout(() => {
    const el = document.createElement("div");
    el.className = "pirate-splat";
    const says = [...MUMBLES].sort(() => Math.random() - 0.5).slice(0, 3);
    el.innerHTML = `<div class="ps-banner">You've been swashbuckled!<small>by ${esc(from)}</small></div>
      <div class="ps-body"><img src="/art/pirate-splat.webp" alt=""><span class="drool d1"></span><span class="drool d2"></span><span class="drool d3"></span></div>
      ${says.map((t, i) => `<div class="ps-say s${i + 1}">${esc(t)}</div>`).join("")}`;
    box.appendChild(el);
    navigator.vibrate?.([60, 40, 160]);
    setTimeout(() => el.classList.add("slide"), PIRATE_SPLAT_MS);
    setTimeout(() => el.remove(), PIRATE_SPLAT_MS + 1300);
  }, wait);
}

export function krakenOverlay(box: HTMLElement, s: PubState, me = "") {
  const k = s.phase === "kraken" ? s.kraken : undefined;
  box.hidden = !k;
  if (!k) return;
  const t = serverNow() - k.at;
  const names = k.candidates.map((pk) => ({ pk, name: s.players[pk]?.name ?? "?" }));
  if (k.lottery === false) {
    const mine = k.doomed.includes(me);
    box.innerHTML = `<div class="kr-title">🐙 THE KRAKEN STRIKES!</div>
      <div class="kr-sub">${me && mine ? "You're at the bottom of the board… and now the bottom of the sea!" : "The bottom of the board go to the bottom of the sea."}</div>
      <div class="kr-names">${names.map(({ pk, name }) => `<span class="kr-name doomed ${pk === me ? "me" : ""}" style="--who:${playerColor(pk)}">${esc(name)} ☠️</span>`).join("")}</div>`;
    return;
  }
  let lit = -1;
  if (t > 1200 && t < KRAKEN_REVEAL) {
    // the spin: fast, then slower and slower
    const f = (t - 1200) / (KRAKEN_REVEAL - 1200);
    const steps = Math.floor(36 * (1 - Math.pow(1 - f, 2.5)));
    lit = steps % names.length;
  }
  const revealed = t >= KRAKEN_REVEAL;
  const mine = k.doomed.includes(me);
  box.innerHTML = `<div class="kr-title">🐙 THE KRAKEN STIRS!</div>
    <div class="kr-sub">${revealed ? (me && mine ? "You're being dragged to the bottom of the sea!" : "Down to Davy Jones' locker…") : "The bottom third go into the lottery. Half get eaten."}</div>
    <div class="kr-names">${names
      .map(({ pk, name }, i) => {
        const cls = revealed ? (k.doomed.includes(pk) ? "doomed" : "spared") : i === lit ? "lit" : "";
        return `<span class="kr-name ${cls} ${pk === me ? "me" : ""}" style="--who:${playerColor(pk)}">${esc(name)}${revealed ? (k.doomed.includes(pk) ? " ☠️" : " 😅") : ""}</span>`;
      })
      .join("")}</div>`;
}

/**
 * The 3-2-1 before a round, then "FIRE THE CANNONS!". Runs on its own every frame, so the
 * numbers tick over exactly on the second.
 */
export function countdown(el: HTMLElement, state: () => PubState | null) {
  let last = "";
  const frame = () => {
    const s = state();
    const left = s && s.phase === "open" && s.goAt ? s.goAt - serverNow() : -99_999;
    const say = left > 0 ? String(Math.ceil(left / 1000)) : left > -1400 ? "FIRE THE CANNONS!" : "";
    if (say !== last) {
      last = say;
      el.hidden = !say;
      el.innerHTML = say ? `<span class="${say.length > 2 ? "fire" : "num"}">${say}</span>` : "";
      if (say && say.length > 2) navigator.vibrate?.(150);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** "Round 2" / "The 3 Ship Showdown": what's coming up, for the get-ready notice. */
export function upNext(s: PubState) {
  return s.show.stage === "final" ? "the 3 Ship Showdown" : `Round ${s.show.round}`;
}

/** 1 -> "1st", 22 -> "22nd" */
export function ordinal(n: number) {
  const t = n % 100;
  const k = n % 10;
  return `${n}${t >= 11 && t <= 13 ? "th" : k === 1 ? "st" : k === 2 ? "nd" : k === 3 ? "rd" : "th"}`;
}

/** A pirate's word on where you stand, from the captain's chair to the bottom of the sea. */
export function pirateCheer(rank: number, of: number) {
  if (!rank || of <= 1) return "Load the cannons, matey!";
  if (rank === 1) return "Ye be captain o' the fleet! Hold yer course and keep firin'!";
  const share = (rank - 1) / (of - 1); // 0 = top, 1 = last
  if (rank <= 3 || share < 0.25) return "Fair winds, ye be near the top! Keep the powder dry and the guns blazin'!";
  if (share < 0.6) return "Steady as she goes, matey. Plenty o' sea left to plunder!";
  if (rank < of) return "Ye be takin' on water! Swab yer deck and shape up, ye scallywag!";
  return "Ye be sleepin' with the fishes! Man the cannons or walk the plank!";
}

/** How a guess went, in a few cheerful words. */
export function guessVerdict(offBlocks: number) {
  const days = Math.abs(offBlocks) / 144;
  if (offBlocks === 0) return "BULLSEYE! Dead on!";
  if (days < 7) return "Incredible guess!";
  if (days < 90) return "Good guess!";
  if (days < 365) return "Not bad, matey!";
  if (days < 365 * 3) return "Ye were in the right ocean, at least!";
  return "Ye were lost at sea on that one!";
}

/** The dial shows the date of the chosen block only in round 1 ("training wheels"). */
export function datesOn(s: PubState) {
  return s.show.stage === "prelim" && s.show.round <= 1;
}
/** Round 2 is loaded and waiting: time to tell everyone the training wheels are off. */
export function wheelsOffNow(s: PubState) {
  return s.phase === "lobby" && s.show.stage === "prelim" && s.show.round === 2;
}
