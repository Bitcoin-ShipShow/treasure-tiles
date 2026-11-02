// The test lab: the board, four phones and the host controls on one screen, so one person can
// play a whole game. Each phone is the real player page with its own key (?seat=N).

import type { PubState } from "../shared/types.ts";
import { Conn, loadConfig } from "./net.ts";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { $, clockText, esc, phaseLine, playerColor, roundLabel, secondsLeft, showPoints } from "./ui.ts";

const SEATS = 4;
const TOKEN_KEY = "treasure-tiles.host";
let token = "";
try {
  token = localStorage.getItem(TOKEN_KEY) ?? "";
} catch {
  /* fine */
}

interface Secrets {
  answer: string;
  aka: Record<string, string[]>;
  puzzles: { id: string; title: string; hasImage: boolean }[];
  puzzleId: string;
  bots: number;
}
let secrets: Secrets | null = null;
/** Which phone the answer chips type into. */
let target = 1;

async function api(path: string, body?: unknown) {
  const r = await fetch(`/api/host/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "x-host-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Failed (${r.status})`);
  return j;
}
function say(msg: string, bad = false) {
  const el = $("#msg");
  el.textContent = msg;
  el.className = bad ? "bad" : "ok";
  setTimeout(() => el.textContent === msg && (el.textContent = ""), 4000);
}
const act = (path: string, body: unknown = {}) => async () => {
  try {
    await api(path, body);
    await loadSecrets();
  } catch (e) {
    say((e as Error).message, true);
  }
};

$("#login").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = ($("#pw") as HTMLInputElement).value.trim();
  try {
    await api("check", {});
    localStorage.setItem(TOKEN_KEY, token);
    void start();
  } catch {
    say("Wrong password", true);
  }
});
if (token) api("check", {}).then(start, () => ($("#gate").hidden = false));
else $("#gate").hidden = false;

let conn: Conn;
async function start() {
  $("#gate").hidden = true;
  $("#lab").hidden = false;
  buildSeats();
  const cfg = await loadConfig();
  await loadSecrets();
  conn = new Conn(cfg, render);
  setInterval(() => conn.state && status(conn.state), 250);
  setInterval(() => void loadSecrets(), 3000);
  new ResizeObserver(fit).observe(document.body);
}

async function loadSecrets() {
  try {
    secrets = await api("state");
  } catch {
    return;
  }
  const sel = $("#puzzle") as HTMLSelectElement;
  if (document.activeElement !== sel) sel.innerHTML = secrets!.puzzles.map((p) => `<option value="${p.id}" ${p.id === secrets!.puzzleId ? "selected" : ""}>${esc(p.title)}${p.hasImage ? "" : " (placeholder)"}</option>`).join("");
  const words = secrets!.answer.split(" ");
  $("#answer-words").innerHTML =
    words.map((w) => (w === w.toUpperCase() ? `<button class="chip" data-word="${esc(w)}">${esc(w)}</button>` : `<span class="muted">${esc(w)}</span>`)).join(" ") +
    ` <button class="chip whole" data-word="${esc(secrets!.answer)}">whole phrase</button> <button class="chip wrong" data-word="llama">a wrong word</button>`;
  $("#aka").innerHTML = Object.entries(secrets!.aka).filter(([, v]) => v.length).map(([k, v]) => `<b>${esc(k)}</b>: ${v.map(esc).join(", ")}`).join(" · ") || "none";
  $("#bots").textContent = String(secrets!.bots);
}

// ───── controls ─────
$("#new").addEventListener("click", () => void act("new", { puzzleId: ($("#puzzle") as HTMLSelectElement).value })());
$("#start").addEventListener("click", async () => {
  // After a game ends, Start means "play again": reload the chosen puzzle, then start.
  try {
    if (conn.state?.phase === "final") await api("new", { puzzleId: ($("#puzzle") as HTMLSelectElement).value });
    await api("start", {});
  } catch (e) {
    say((e as Error).message, true);
  }
});
$("#next-round").addEventListener("click", act("next-round"));
$("#final-btn").addEventListener("click", act("final"));
$("#new-show").addEventListener("click", act("new-show"));
$("#pause").addEventListener("click", () => void act(conn.state?.phase === "paused" ? "resume" : "pause")());
$("#addtime").addEventListener("click", act("add-time", { seconds: 30 }));
$("#end").addEventListener("click", act("end"));
$("#bots-add").addEventListener("click", act("bots/add", { count: 3 }));
$("#bots-clear").addEventListener("click", act("bots/clear"));
$("#reset").addEventListener("click", async () => {
  // Everyone off: remove all players and bots, give each phone a fresh key, reload the phones.
  if (!confirm("Remove every player (and bots) and start the phones fresh?")) return;
  try {
    await api("players/clear", {});
  } catch (e) {
    return say((e as Error).message, true);
  }
  for (let i = 1; i <= SEATS; i++) {
    localStorage.removeItem(`treasure-tiles.key.${i}`);
    localStorage.removeItem(`treasure-tiles.name${i}`);
  }
  buildSeats();
});

// Answer chips type into the ticked phone.
$("#answer-words").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-word]") as HTMLElement | null;
  if (!b) return;
  const frame = document.querySelector<HTMLIFrameElement>(`#seat-${target} iframe`);
  const input = frame?.contentDocument?.querySelector<HTMLInputElement>("#guess");
  if (!input) return say("That phone isn't ready", true);
  input.value = b.dataset.word!.toLowerCase();
  input.focus();
  say(`Typed into phone ${target}. Press Guess on it.`);
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.target) target = Number(el.dataset.target);
});

function seatPubkey(i: number): string | null {
  const hex = localStorage.getItem(`treasure-tiles.key.${i}`);
  return hex && /^[0-9a-f]{64}$/.test(hex) ? getPublicKey(hexToBytes(hex)) : null;
}

// ───── drawing ─────
function render(s: PubState) {
  for (let i = 1; i <= SEATS; i++) {
    const pk = seatPubkey(i);
    const p = pk ? s.players[pk] : null;
    const box = $(`#seat-${i}`);
    const color = pk ? playerColor(pk) : "#D9AE3C";
    const peeking = !!pk && Object.values(s.cracking ?? {}).some((c) => c.pk === pk);
    box.classList.toggle("up", peeking);
    box.style.setProperty("--crew", color);
    box.querySelector(".seat-label")!.innerHTML = `<label><input type="radio" name="target" ${target === i ? "checked" : ""} data-target="${i}"> Phone ${i}</label>${p ? ` · <b style="color:${color}">${esc(p.name)}</b> ${showPoints(s, pk!)} pts` : " · joining…"}${peeking ? ` <span class="up-tag">PEEKING</span>` : ""}`;
  }
  ($("#start") as HTMLButtonElement).disabled = !["lobby", "final"].includes(s.phase);
  $("#next-round").textContent = s.show.prelimLeft === 0 ? "⏭ Load the 3 Ship Showdown" : "⏭ Load next round";
  $("#start").textContent = s.phase === "final" ? "⚓ Play again" : "⚓ Start";
  $("#pause").textContent = s.phase === "paused" ? "▶ Resume" : "⏸ Pause";
  $("#players").textContent = `${Object.keys(s.players).length} players`;
  status(s);
}

function status(s: PubState) {
  const live = ["open", "paused"].includes(s.phase);
  const top = s.final?.ranking[0];
  $("#status").textContent = `${roundLabel(s)} · ${phaseLine(s)}${live ? ` · ${clockText(secondsLeft(s))} left` : ""}${s.final ? ` · top pirate: ${top ? s.players[top.pk]?.name : "nobody"}` : ""}`;
}

function buildSeats() {
  $("#phones").innerHTML = Array.from({ length: SEATS }, (_, k) => {
    const i = k + 1;
    return `<div class="seat" id="seat-${i}"><div class="seat-label">Phone ${i}</div><div class="phone"><iframe src="/play?seat=${i}&name=${encodeURIComponent(`Tester ${i}`)}" title="Phone ${i}"></iframe></div></div>`;
  }).join("");
  fit();
}

/** Scale the 1920×1080 board and the 390×844 phones to fit their boxes. */
function fit() {
  const b = $("#board-box");
  if (b) {
    const s = b.clientWidth / 1920;
    b.style.height = `${1080 * s}px`;
    ($("#board-frame") as HTMLElement).style.transform = `scale(${s})`;
  }
  for (const ph of document.querySelectorAll<HTMLElement>(".phone")) {
    const s = ph.clientWidth / 390;
    ph.style.height = `${844 * s}px`;
    (ph.firstElementChild as HTMLElement).style.transform = `scale(${s})`;
  }
}
