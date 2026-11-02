// Cuts a puzzle picture into irregular tiles on the server. Pages only ever receive the
// pieces that have fallen, so "inspect element" can't show the hidden picture.

import sharp from "sharp";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Puzzle } from "./puzzles.ts";

export interface Tile {
  points: [number, number][];
  x: number;
  y: number;
  w: number;
  h: number;
  token: string;
}

export interface CutResult {
  w: number;
  h: number;
  tiles: Tile[];
  fullToken: string;
}

const WIDTH = 1600;

/** A small seeded random generator, so a puzzle's tile shapes can be reproduced in tests. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * A jittered grid whose edges wobble: every cell is a polygon, neighbours share their
 * edges exactly, so the pieces cover the picture with no gaps.
 */
export function mesh(w: number, h: number, target: number, rand: () => number, seam?: number): [number, number][][] {
  const cols = Math.max(2, Math.round(Math.sqrt((target * w) / h)));
  const rows = Math.max(2, Math.round(target / cols));
  const cw = w / cols;
  // A seam (0..1 of the height) is one perfectly straight row line, for pictures whose
  // uncovered strip sits close to hidden text: rows above and below it share the rest evenly.
  const seamRow = seam ? Math.min(rows - 1, Math.max(1, Math.round(seam * rows))) : -1;
  const rowY = (r: number) => (seamRow < 0 ? (r * h) / rows : r <= seamRow ? (r / seamRow) * seam! * h : seam! * h + ((r - seamRow) / (rows - seamRow)) * (1 - seam!) * h);
  const V: [number, number][][] = [];
  for (let r = 0; r <= rows; r++) {
    V.push([]);
    for (let c = 0; c <= cols; c++) {
      const edgeX = c === 0 || c === cols;
      const edgeY = r === 0 || r === rows || r === seamRow;
      const ch = rowY(Math.min(rows, r + 1)) - rowY(Math.max(0, r - 1)) || h / rows;
      V[r].push([c * cw + (edgeX ? 0 : (rand() - 0.5) * cw * 0.5), rowY(r) + (edgeY ? 0 : (rand() - 0.5) * ch * 0.25)]);
    }
  }
  // Wobbly edges: two bend points per edge, pushed sideways; border edges stay straight.
  const edges = new Map<string, [number, number][]>();
  const edge = (a: [number, number], b: [number, number], border: boolean, key: string) => {
    let e = edges.get(key);
    if (!e) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      const nx = -dy / len;
      const ny = dx / len;
      e = [1 / 3, 2 / 3].map((t) => {
        const off = border ? 0 : (rand() - 0.5) * len * 0.22;
        return [a[0] + dx * t + nx * off, a[1] + dy * t + ny * off] as [number, number];
      });
      edges.set(key, e);
    }
    return e;
  };
  const cells: [number, number][][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = V[r][c], tr = V[r][c + 1], br = V[r + 1][c + 1], bl = V[r + 1][c];
      const top = edge(tl, tr, r === 0 || r === seamRow, `h${r},${c}`);
      const right = edge(tr, br, c === cols - 1, `v${r},${c + 1}`);
      const bottom = edge(bl, br, r === rows - 1 || r + 1 === seamRow, `h${r + 1},${c}`); // stored left-to-right
      const left = edge(tl, bl, c === 0, `v${r},${c}`); // stored top-to-bottom
      cells.push([tl, ...top, tr, ...right, br, ...[...bottom].reverse(), bl, ...[...left].reverse()]);
    }
  }
  return cells;
}

/**
 * The finished picture, if the puzzle has one (puzzles/images/<id>-reveal.png): sized to match
 * the cut picture and saved under a random name, served only once someone solves it.
 */
export async function saveReveal(p: Puzzle, imagesDir: string, outDir: string, w: number, h: number): Promise<string | undefined> {
  const src = findImage(imagesDir, `${p.id}-reveal`);
  if (!src) return undefined;
  const token = randomBytes(16).toString("hex");
  await sharp(src).rotate().resize(w, h, { fit: "cover" }).jpeg({ quality: 88 }).toFile(join(outDir, `${token}.jpg`));
  return token;
}

export function findImage(dir: string, id: string): string | null {
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const f = join(dir, `${id}.${ext}`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** A stand-in picture: the hidden words written across a parchment scene, for rehearsals. */
export function placeholderSvg(p: Puzzle, w = WIDTH, h = 1200): string {
  const words = p.phrase.split(/\s+/).filter((x) => x === x.toUpperCase() && /[A-Z]/.test(x));
  const r = rng(words.join("").length * 7919);
  const cols = Math.ceil(Math.sqrt(words.length * 1.4));
  const rows = Math.ceil(words.length / cols);
  const hues = [200, 30, 280, 140, 350, 50, 180, 0, 260];
  const items = words
    .map((wd, i) => {
      const cx = ((i % cols) + 0.5) * (w / cols) + (r() - 0.5) * 60;
      const cy = (Math.floor(i / cols) + 0.5) * (h / rows) + (r() - 0.5) * 60;
      const size = Math.min(130, (w / cols / wd.length) * 1.7);
      return `<g transform="rotate(${((r() - 0.5) * 16).toFixed(1)} ${cx} ${cy})">
        <ellipse cx="${cx}" cy="${cy}" rx="${w / cols / 2.3}" ry="${h / rows / 2.8}" fill="hsl(${hues[i % hues.length]} 70% 60%)" stroke="#0B1F33" stroke-width="8"/>
        <text x="${cx}" y="${cy + size * 0.35}" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="${size.toFixed(0)}" fill="#0B1F33">${wd}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#CBDCE8"/>
    <path d="M0 ${h * 0.82} Q ${w / 4} ${h * 0.76} ${w / 2} ${h * 0.82} T ${w} ${h * 0.82} V ${h} H 0 Z" fill="#14486F"/>
    ${items}
    <text x="${w - 30}" y="${h - 30}" text-anchor="end" font-family="Georgia, serif" font-size="34" fill="#CBDCE8" opacity=".8">placeholder picture: add puzzles/images/${p.id}.png</text>
  </svg>`;
}

/** Cut the picture (or a placeholder) into tiles under outDir, with unguessable file names. */
export async function cutPuzzle(p: Puzzle, imagesDir: string, outDir: string, target: number, seed: number): Promise<CutResult> {
  mkdirSync(outDir, { recursive: true });
  const src = findImage(imagesDir, p.id);
  const base = sharp(src ?? Buffer.from(placeholderSvg(p))).rotate().resize({ width: WIDTH, withoutEnlargement: false });
  const buf = await base.png().toBuffer();
  const meta = await sharp(buf).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const cells = mesh(w, h, target, rng(seed), p.seam);
  const fullToken = randomBytes(16).toString("hex");
  await sharp(buf).jpeg({ quality: 86 }).toFile(join(outDir, `${fullToken}.jpg`));
  const tiles: Tile[] = [];
  for (const pts of cells) {
    const pad = 3; // a little overlap so no hairline gaps show between neighbours
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const x = Math.max(0, Math.floor(Math.min(...xs)) - pad);
    const y = Math.max(0, Math.floor(Math.min(...ys)) - pad);
    const tw = Math.min(w, Math.ceil(Math.max(...xs)) + pad) - x;
    const th = Math.min(h, Math.ceil(Math.max(...ys)) + pad) - y;
    const poly = pts.map(([px, py]) => `${(px - x).toFixed(1)},${(py - y).toFixed(1)}`).join(" ");
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><polygon points="${poly}" fill="#fff" stroke="#fff" stroke-width="${pad * 2}" stroke-linejoin="round"/></svg>`);
    const token = randomBytes(16).toString("hex");
    await sharp(buf)
      .extract({ left: x, top: y, width: tw, height: th })
      .ensureAlpha()
      .composite([{ input: mask, blend: "dest-in" }])
      .webp({ quality: 85 })
      .toFile(join(outDir, `${token}.webp`));
    tiles.push({ points: pts.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]), x, y, w: tw, h: th, token });
  }
  return { w, h, tiles, fullToken };
}
