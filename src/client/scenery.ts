// The cove's moving parts, drawn from the painted sprites in public/art: a palm tree, a toucan,
// a dancing pirate, one sleeping it off, a treasure chest, rum barrels and a kraken in the
// lagoon. When a cannonball lands near one of them, it reacts (purely for fun, no points).

import { MOVING, PROPS, propAt, type Cove, type PropKind } from "../shared/cannon.ts";

/** Each sprite's width / height, so it can be drawn at a given height. */
const ASPECT: Partial<Record<PropKind, number>> = {
  palm: 245 / 360, toucan: 344 / 360, chest: 360 / 358, rum: 360 / 334, drunk: 360 / 275, dancer: 239 / 360, kraken: 360 / 355,
  crab: 360 / 341, parrot: 207 / 360, shark: 360 / 200, rowboat: 360 / 213, seagull: 360 / 249, bottle: 351 / 360, monkey: 247 / 360,
  mermaid: 346 / 360, hammock: 360 / 243, turtle: 360 / 185, cannon: 360 / 241,
};

/**
 * The still scenery as little HTML layers over the scene (one per character), each with its own
 * small drawing. Their idle wiggles then move on the graphics card instead of making the whole
 * scene redraw every frame. `vb` is the part of the cove the screen shows.
 */
export function propsHtml(vb: { x: number; y: number; w: number; h: number }) {
  return PROPS.map((p, i) => {
    if (!p.size) return "";
    const moving = MOVING.has(p.kind);
    const h = p.size;
    const w = h * (ASPECT[p.kind] ?? 1);
    const ar = ASPECT[p.kind] ?? 1;
    const pad = 24 * (h / (ar <= 1 ? 360 : 360 / ar));
    // the box (scene units), then as % of the view
    // travellers sit at the scene's origin and are moved each frame with a transform
    const bx = (moving ? 0 : p.x) - w / 2 - pad;
    const by = (moving ? 0 : p.y) - h - pad;
    const bw = w + 2 * pad;
    const bh = h + 2 * pad;
    const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;
    let extra = "";
    if (p.kind === "palm") extra = `<circle class="coconut" cx="${w * 0.06}" cy="${-h * 0.8}" r="${h * 0.028}" fill="#6b4423" stroke="#3a2412" stroke-width="2"/>`;
    if (p.kind === "chest") extra = Array.from({ length: 7 }, (_, k) => `<circle class="coin c${k}" style="--i:${k}" cx="${-w * 0.2 + k * w * 0.07}" cy="${-h * 0.55}" r="${h * 0.05}" fill="#f3c63f" stroke="#a87b12" stroke-width="2"/>`).join("");
    return `<div class="prop prop-html prop-${p.kind}${moving ? " moving" : ""}" data-prop="${i}" style="left:${pct(bx - vb.x, vb.w)};top:${pct(by - vb.y, vb.h)};width:${pct(bw, vb.w)};height:${pct(bh, vb.h)};z-index:${Math.round(p.y)}"><div class="face"><svg class="sprite" viewBox="${-w / 2 - pad} ${-h - pad} ${bw} ${bh}" overflow="visible"><image href="/art/glow/${p.kind}.webp" x="${-w / 2 - pad}" y="${-h - pad}" width="${bw}" height="${bh}"/>${extra}</svg></div></div>`;
  }).join("");
}

/** The scenery sprites: those that travel (moving = true), or those that stand still. */
export function propsSvg(moving?: boolean) {
  return PROPS.map((p, i) => {
    if (!p.size) return ""; // part of the painting itself: nothing drawn
    if (moving !== undefined && MOVING.has(p.kind) !== moving) return "";
    const h = p.size;
    const w = h * (ASPECT[p.kind] ?? 1);
    // the gold glow is baked into public/art/glow/*.webp (24px of glow around the 360px sprite),
    // so there's no live blur to redraw every frame
    const ar = ASPECT[p.kind] ?? 1;
    const pad = 24 * (h / (ar <= 1 ? 360 : 360 / ar));
    const img = `<image href="/art/glow/${p.kind}.webp" x="${-w / 2 - pad}" y="${-h - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}"/>`;
    let extra = "";
    if (p.kind === "palm") extra = `<circle class="coconut" cx="${w * 0.06}" cy="${-h * 0.8}" r="${h * 0.028}" fill="#6b4423" stroke="#3a2412" stroke-width="2"/>`;
    if (p.kind === "chest") extra = Array.from({ length: 7 }, (_, k) => `<circle class="coin c${k}" style="--i:${k}" cx="${-w * 0.2 + k * w * 0.07}" cy="${-h * 0.55}" r="${h * 0.05}" fill="#f3c63f" stroke="#a87b12" stroke-width="2"/>`).join("");
    return `<g class="prop prop-${p.kind}" data-prop="${i}" transform="translate(${p.x} ${p.y})"><g class="face"><g class="sprite">${img}${extra}</g></g></g>`;
  }).join("");
}

const LINES: Record<PropKind, string[]> = {
  crab: ["snip snip!", "OI, me shell!"],
  parrot: ["PIECES OF EIGHT!", "SQUAWK! RUDE!"],
  monkey: ["OOK OOK!", "*throws coconut*"],
  mermaid: ["how rude!", "I'm calling the kraken"],
  hammock: ["WHOA—", "*thud*"],
  cannon: ["BOOM back!", "it fires back!"],
  shark: ["CHOMP!", "*dives*"],
  rowboat: ["we're rowing here!", "man overboard!"],
  seagull: ["CAW!", "feathers everywhere"],
  bottle: ["a message!", "*bonk*"],
  turtle: ["…slowly ducks", "excuse me"],
  // painted parts
  bonfire: ["FWOOSH!", "me eyebrows!"],
  dock: ["CRACK!", "the dock!"],
  guitarist: ["*twaaang*", "I was mid-song!"],
  singers: ["…YO HO—", "off key anyway!"],
  laundry: ["me knickers!", "that was clean!"],
  hut: ["who's knocking?", "THUD"],
  flag: ["riiip!", "not the colors!"],
  banner: ["me flag!", "show some respect!"],
  barrels: ["BOOM… rum everywhere", "glug glug glug"],
  boozer: ["ARRR!", "I'll get ye for that!"],
  palm: ["bonk!", "coconut!"],
  toucan: ["SQUAWK!", "rude!"],
  chest: ["clink!", "me gold!"],
  rum: ["glug glug", "NOT THE RUM!"],
  drunk: ["HIC!", "five more minutes…"],
  dancer: ["yo ho!", "whoa!"],
  kraken: ["SPLOOSH", "GRRR"],
  tavern: ["OI! WATCH IT!", "MY RUM!", "who did that?!"],
};

/** Move the travelling props (called every frame). */
export function moveProps(root: HTMLElement, t: number, k: number) {
  // k: screen pixels per scene unit (measured on resize, not per frame)
  PROPS.forEach((p, i) => {
    if (!MOVING.has(p.kind)) return;
    const el = root.querySelector<HTMLElement>(`[data-prop="${i}"]`);
    if (!el) return;
    const at = propAt(p, t);
    el.style.transform = `translate3d(${(at.x * k).toFixed(1)}px, ${(at.y * k).toFixed(1)}px, 0)`;
    // back to front: lower on the screen = nearer = on top (the shark slips behind the kraken)
    el.style.zIndex = String(Math.round(at.y));
    const face = el.firstElementChild as HTMLElement | null;
    if (face) face.style.transform = at.facing < 0 ? "scaleX(-1)" : "";
  });
}

/** A cannonball landed at (x, y) at time t (seconds): anything close by reacts. */
export function reactToShot(root: Element, svg: SVGSVGElement, x: number, y: number, t: number, say: (x: number, y: number, word: string) => void) {
  PROPS.forEach((p, i) => {
    const at = propAt(p, t);
    const cy = at.y - p.size / 2; // aim at the middle of the thing, not its feet
    if (Math.hypot(at.x - x, (p.size ? cy : at.y) - y) > p.r) return;
    const el = root.querySelector<SVGGElement>(`[data-prop="${i}"]`);
    if (el?.classList.contains("busy")) return;
    const words = LINES[p.kind];
    say(p.size ? at.x : x, (p.size ? at.y - p.size : y) - 20, words[Math.floor(Math.random() * words.length)]);
    if (!el) return void burst(svg, p.kind, at.x, at.y);
    // palms only drop a coconut sometimes
    const kind = p.kind === "palm" && Math.random() < 0.5 ? "shake" : p.kind;
    el.classList.add("busy", `hit-${kind}`);
    setTimeout(() => el.classList.remove("busy", `hit-${kind}`), p.kind === "toucan" ? 6000 : 2200);
  });
}

/** Painted parts of the scene can't move, so they get a little burst: sparks, splinters, smoke. */
function burst(svg: SVGSVGElement, kind: PropKind, x: number, y: number) {
  const fire = kind === "bonfire" || kind === "barrels";
  const wood = kind === "dock" || kind === "hut" || kind === "tavern";
  const cloth = kind === "laundry" || kind === "flag" || kind === "banner";
  const color = fire ? "#ffb02e" : wood ? "#8a5a2c" : cloth ? "#f4efe4" : "#d8cbb8";
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "burst");
  g.setAttribute("transform", `translate(${x} ${y})`);
  g.innerHTML = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    const d = 60 + (i % 3) * 30;
    return `<rect x="-5" y="-5" width="${fire ? 9 : 12}" height="${fire ? 9 : 6}" fill="${color}" style="--tx:${(Math.cos(a) * d).toFixed(0)}px;--ty:${(Math.sin(a) * d - 40).toFixed(0)}px"/>`;
  }).join("");
  svg.appendChild(g);
  setTimeout(() => g.remove(), 1200);
}
