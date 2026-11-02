// The host console: pick a puzzle, run the clock, manage crews, tune the rules.

import type { PubState, Settings } from "../shared/types.ts";
import { Conn, loadConfig } from "./net.ts";
import { $, clockText, esc, feedItem, fmt, phaseLine, playerColor, roundLabel, secondsLeft, showPoints, toast } from "./ui.ts";

interface Secrets {
  answer: string;
  aka: Record<string, string[]>;
  clues: string[];
  imagePrompt: string;
  puzzles: { id: string; title: string; hasImage: boolean }[];
  puzzleId: string;
  connections: number;
  bots: number;
  payouts: { pk: string; name: string; sats: number; address: string | null; status: string | null; error: string | null }[];
  wallet: { connected: boolean; alias: string; balance: number | null };
}

const TOKEN = "treasure-tiles.host";
let token = "";
try {
  token = localStorage.getItem(TOKEN) ?? "";
} catch {
  /* fine */
}
let secrets: Secrets | null = null;
let settingsDirty = false;

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
    localStorage.setItem(TOKEN, token);
    start();
  } catch {
    say("Wrong password", true);
  }
});
if (token) api("check", {}).then(start, () => ($("#gate").hidden = false));
else $("#gate").hidden = false;

let conn: Conn;
async function start() {
  $("#gate").hidden = true;
  $("#console").hidden = false;
  const cfg = await loadConfig();
  $("#links").innerHTML = `<a href="/board" target="_blank">Board (OBS, 1920×1080)</a> <a href="/play" target="_blank">Player page</a> <span class="muted">Join link: ${esc(cfg.publicUrl)}/play</span>`;
  await loadSecrets();
  conn = new Conn(cfg, render);
  setInterval(() => conn.state && clock(conn.state), 250);
  setInterval(() => void loadSecrets(), 3000);
}

async function loadSecrets() {
  try {
    secrets = await api("state");
  } catch {
    return;
  }
  const sel = $("#puzzle") as HTMLSelectElement;
  if (document.activeElement !== sel) sel.innerHTML = secrets!.puzzles.map((p) => `<option value="${p.id}" ${p.id === secrets!.puzzleId ? "selected" : ""}>${esc(p.title)}${p.hasImage ? "" : " (placeholder picture)"}</option>`).join("");
  $("#answer").innerHTML = `<p class="answer-text">${esc(secrets!.answer)}</p>
    <p class="small"><b>Also accepted:</b> ${Object.entries(secrets!.aka).filter(([, v]) => v.length).map(([k, v]) => `${esc(k)} = ${v.map(esc).join(", ")}`).join(" · ") || "none"}</p>
    <ol class="small">${secrets!.clues.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
    <p class="small muted"><b>Picture prompt:</b> ${esc(secrets!.imagePrompt)}</p>`;
  $("#conns").textContent = `${secrets!.connections} connected · ${secrets!.bots} bots`;
  const w = secrets!.wallet;
  $("#wallet-line").innerHTML = w.connected ? `<b class="ok">connected</b>${w.alias ? ` (${esc(w.alias)})` : ""}${w.balance !== null ? ` · balance <b>${fmt(w.balance)} sats</b>` : ""}` : `<b class="bad">not connected</b> (you'll pay the winner by hand)`;
  // the final's winners and where to pay them
  $("#payouts").innerHTML = secrets!.payouts.length
    ? `<h3>💸 Pay the winners</h3><table class="payouts">${secrets!.payouts
        .map((p) => {
          const st = p.status === "paid" ? `<b class="ok">⚡ paid</b>` : p.status === "paying" ? "paying…" : p.status === "failed" ? `<b class="bad">failed</b> <small>${esc(p.error)}</small> <button class="btn small" data-pay="${p.pk}">Retry</button>` : p.address ? `<button class="btn small" data-pay="${p.pk}">Pay now</button>` : "";
          return `<tr><td>${esc(p.name)}</td><td>${fmt(p.sats)} sats</td><td>${p.address ? `<code>${esc(p.address)}</code> <button class="btn small" data-copy="${esc(p.address)}">Copy</button>` : `<span class="muted">waiting for their address…</span>`}</td><td>${st}</td></tr>`;
        })
        .join("")}</table>`
    : "";
}
$("#payouts").addEventListener("click", (e) => {
  const pay = (e.target as HTMLElement).closest<HTMLElement>("[data-pay]");
  if (pay) return void api("pay", { pk: pay.dataset.pay }).then(() => setTimeout(loadSecrets, 1500), (err) => toast(String(err.message ?? err), "error"));
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (b) void navigator.clipboard?.writeText(b.dataset.copy!).then(() => toast("Copied", "ok"));
});

$("#peek").addEventListener("click", () => $("#answer").classList.toggle("blur"));
$("#new").addEventListener("click", () => {
  if (conn.state && !["lobby", "final"].includes(conn.state.phase) && !confirm("A game is running. Throw it away and load a new puzzle?")) return;
  void act("new", { puzzleId: ($("#puzzle") as HTMLSelectElement).value })().then(() => say("Puzzle loaded: press Start when the fleet is ready"));
});
$("#start").addEventListener("click", act("start"));
$("#next-round").addEventListener("click", () => void act("next-round")().then(() => say("Loaded: everyone sees 'Get ready'. Press Start round when you're set.")));
$("#final-btn").addEventListener("click", () => confirm("Load the final? The top 3 by total points play; everyone else watches.") && void act("final")());
$("#new-show").addEventListener("click", () => confirm("Start a new show? All totals go back to zero.") && void act("new-show")());
$("#pause").addEventListener("click", () => void act(conn.state?.phase === "paused" ? "resume" : "pause")());
$("#addtime").addEventListener("click", act("add-time", { seconds: 30 }));
$("#end").addEventListener("click", () => confirm("End the game now? Most points wins.") && void act("end")());
$("#bots-add").addEventListener("click", act("bots/add", { count: 6 }));
$("#bots-clear").addEventListener("click", act("bots/clear"));

const NUMS = ["countdownSeconds", "gameSeconds", "finalSeconds", "targetCooldownSeconds", "hitPoints", "krakenAfterSeconds", "krakenRounds", "krakenMinPlayers", "tiles", "reloadSeconds", "peekSeconds", "lockoutSeconds", "letterEverySeconds", "clueEverySeconds", "solveBonus", "prizePool"] as const;
const TEXTS = ["title", "tagline", "freeLetters", "prizeSplit"] as const;

$("#settings").addEventListener("input", () => (settingsDirty = true));
$("#settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = $("#settings") as HTMLFormElement;
  const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
  const patch: Record<string, unknown> = {};
  for (const k of NUMS) patch[k] = Number(v(k));
  for (const k of TEXTS) patch[k] = v(k);
  try {
    await api("settings", patch as Partial<Settings>);
    settingsDirty = false;
    say("Saved. A new slab count or starting letters reloads the puzzle (between games only).");
  } catch (err) {
    say((err as Error).message, true);
  }
});

function fillSettings(s: Settings) {
  if (settingsDirty) return;
  const f = $("#settings") as HTMLFormElement;
  for (const k of [...NUMS, ...TEXTS]) (f.elements.namedItem(k) as HTMLInputElement).value = String(s[k]);
}

function clock(s: PubState) {
  $("#clock").textContent = ["open", "paused"].includes(s.phase) ? clockText(secondsLeft(s)) : "";
}

function render(s: PubState) {
  $("#phase").textContent = `${roundLabel(s)} · ${phaseLine(s)}`;
  const running = ["open", "paused"].includes(s.phase);
  ($("#next-round") as HTMLButtonElement).disabled = running || s.show.stage === "final";
  $("#next-round").textContent = s.show.prelimLeft === 0 ? "⏭ Load the 3 Ship Showdown" : "⏭ Load next round";
  ($("#final-btn") as HTMLButtonElement).disabled = running || s.show.stage === "final";
  ($("#start") as HTMLButtonElement).disabled = s.phase !== "lobby";
  $("#pause").textContent = s.phase === "paused" ? "▶ Resume" : "⏸ Pause";
  ($("#pause") as HTMLButtonElement).disabled = !["open", "paused"].includes(s.phase);
  ($("#addtime") as HTMLButtonElement).disabled = s.phase !== "open";
  ($("#end") as HTMLButtonElement).disabled = ["lobby", "final"].includes(s.phase);
  $("#score-line").innerHTML = "";
  $("#final-line").innerHTML = s.final
    ? `Top pirates: ${s.final.ranking.slice(0, 5).map((r) => `${esc(s.players[r.pk]?.name ?? "?")} ${r.points} pts → ${fmt(r.share)} sats`).join(" · ") || "nobody scored"} (${s.final.reason})`
    : "";
  fillSettings(s.settings);
  const ps = Object.entries(s.players).sort((a, b) => showPoints(s, b[0]) - showPoints(s, a[0]));
  $("#roster").innerHTML =
    ps.map(([pk, p]) => `<div class="h-player"><span style="color:${playerColor(pk)}">${s.show.finalists.includes(pk) ? "⚔️ " : ""}${esc(p.name)}${p.bot ? " 🤖" : ""}${p.npub ? " 🟣" : ""}</span><small class="muted">${showPoints(s, pk)} pts · 🎯 ${p.hits}/${p.shots}</small><button class="btn small danger" data-remove="${pk}">✕</button></div>`).join("") ||
    `<p class="muted small">Nobody yet</p>`;
  $("#hfeed").innerHTML = s.feed
    .slice()
    .reverse()
    .map((f) => `<div class="h-feed">${feedItem({ ...f, hidden: false }, s).replace(/^<li[^>]*>|<\/li>$/g, "")} ${f.kind === "miss" ? `<button class="btn small" data-hide="${f.id}" data-hidden="${f.hidden ? 1 : 0}">${f.hidden ? "Show on board" : "Hide from board"}</button>` : ""}</div>`)
    .join("");
}

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!el) return;
  if (el.dataset.remove && confirm("Remove this player?")) void act("remove", { pk: el.dataset.remove })();
  if (el.dataset.hide) void act("hide", { id: Number(el.dataset.hide), hidden: el.dataset.hidden !== "1" })();
});

$("#wallet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = ($("#wallet-url") as HTMLInputElement).value.trim();
  if (!url) return;
  try {
    await api("wallet", { url });
    ($("#wallet-url") as HTMLInputElement).value = "";
    toast("Wallet connected", "ok");
  } catch (err) {
    toast(String((err as Error).message ?? err), "error");
  }
  void loadSecrets();
});
$("#wallet-off").addEventListener("click", async () => {
  if (!confirm("Disconnect the game's wallet?")) return;
  await api("wallet", { url: "" });
  void loadSecrets();
});
