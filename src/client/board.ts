// The broadcast board (OBS browser source, 1920x1080): the cove with the whole fleet firing at
// the cliff, the phrase, the right answers as they land, and the leaderboard. Wrong guesses
// become one line of stats so the screen stays readable. Never shows anything secret.

import type { PubState } from "../shared/types.ts";
import { dayMonthYear, offText } from "../shared/blocks.ts";
import { Conn, loadConfig } from "./net.ts";
import { $, clockText, countdown, Cove, wheelsOffNow, miniBoard, upNext, esc, fmt, krakenOverlay, leaderboard, phaseLine, pirateConfetti, playerColor, roundLabel, secondsLeft, shipIcon, showPoints, verifySeal } from "./ui.ts";

const cfg = await loadConfig();
if (new URLSearchParams(location.search).has("transparent")) document.documentElement.classList.add("transparent");

const scene = new Cove($("#cove"));
let lastFinal = "";
let finalTimer = 0;
let revealTimer = 0;

$("#join-url").textContent = `${cfg.publicUrl.replace(/^https?:\/\//, "")}/play`;
($("#qr") as HTMLImageElement).src = `/api/qr.svg?text=${encodeURIComponent(`${cfg.publicUrl}/play`)}`;
($("#join-btn") as HTMLAnchorElement).href = `${cfg.publicUrl}/play`;
$("#home-url").textContent = `${cfg.publicUrl.replace(/^https?:\/\//, "")}/play`;
($("#home-qr") as HTMLImageElement).src = `/api/qr.svg?text=${encodeURIComponent(`${cfg.publicUrl}/play`)}`;

const conn = new Conn(cfg, render, (on) => document.body.classList.toggle("offline", !on));
setInterval(() => conn.state && clock(conn.state), 200);
countdown($("#countdown"), () => conn.state);

function render(s: PubState) {
  // the treasure, wherever it's mentioned
  for (const el of document.querySelectorAll(".prize-sats")) el.textContent = fmt(s.settings.prizePool);
  document.title = `${s.settings.title} board`;
  $("#title").textContent = s.settings.title;
  $("#tagline").textContent = s.settings.tagline;
  $("#pool").textContent = fmt(s.settings.prizePool);
  document.body.dataset.phase = s.phase;
  scene.update(s);
  $("#board").innerHTML = miniBoard(s, "", s.phase === "lobby" || s.phase === "final");
  $("#seal").innerHTML = `🔒 Answer sealed before play · sha256 <code>${s.commitment.slice(0, 12)}…${s.commitment.slice(-6)}</code>${s.final ? (verifySeal(s) ? ` <b class="ok">✓ matches</b>` : ` <b class="bad">✗ does not match</b>`) : ""}`;
  const n = Object.keys(s.players).length;
  $("#locked").innerHTML = s.phase === "open" || s.phase === "paused" ? `🔒 <b>${(s.locked ?? []).length}</b>/${n} locked in` : "";
  home(s);
  // the join code is for boarding: gone once the show is under way
  document.body.classList.toggle("underway", s.phase !== "lobby" || s.show.round > 1 || s.show.stage === "final");
  // nothing shows until the first update has picked the right screen (no flash of the wrong one)
  document.body.classList.remove("booting");
  lobby(s);
  final(s);
  clock(s);
}

function clock(s: PubState) {
  krakenOverlay($("#kraken"), s);
  $("#round").textContent = roundLabel(s);
  document.body.dataset.stage = s.show.stage;
  const live = ["open", "paused", "kraken"].includes(s.phase);
  const left = s.phase === "kraken" && s.kraken ? Math.ceil((s.deadline - s.kraken.at) / 1000) : secondsLeft(s);
  $("#clock").textContent = live ? clockText(left) : s.phase === "final" ? (s.final?.showOver || s.final?.stage === "final" ? "Game over" : "Round over") : "";
  $("#clock").classList.toggle("urgent", s.phase === "open" && left <= 10);
  $("#phase").textContent = s.phase === "lobby" ? (s.show.round > 1 || s.show.stage === "final" ? `Get ready for ${upNext(s)}!` : "Now boarding: scan the code to join") : phaseLine(s);
}

/** Before the show's first round starts: a big join screen. It goes away when the host starts. */
function home(s: PubState) {
  const on = s.phase === "lobby" && s.show.stage === "prelim" && s.show.round <= 1;
  $("#home").hidden = !on;
  document.body.classList.toggle("at-home", on);
  if (!on) return;
  // every ship that joins sails into the lagoon on the left
  const fleet = Object.entries(s.players).sort((a, b) => a[1].slot - b[1].slot);
  const box = $("#home-ships");
  const want = new Set(fleet.map(([pk]) => pk));
  for (const el of [...box.children] as HTMLElement[]) if (!want.has(el.dataset.pk!)) el.remove();
  for (const [pk, p] of fleet) {
    const key = `${p.name}|${p.picture ?? ""}`;
    let el = box.querySelector<HTMLElement>(`[data-pk="${pk}"]`);
    if (el && el.dataset.key === key) continue;
    el?.remove();
    el = document.createElement("div");
    el.className = "hs-ship";
    el.dataset.pk = pk;
    el.dataset.key = key;
    el.dataset.slot = String(p.slot);
    el.innerHTML = `<div class="hs-flip">${shipIcon(playerColor(pk), "ship", { picture: p.picture })}</div><span style="color:${playerColor(pk)}">${esc(p.name)}</span>`;
    box.appendChild(el);
  }
  // once the fleet is filling up, a box for the viewers who aren't playing
  // ?point in the address shows it regardless (to check how it looks)
  $("#home-point").hidden = fleet.length < 5 && !new URLSearchParams(location.search).has("point");
  const names = Object.entries(s.players).map(([pk, p]) => `<b style="color:${playerColor(pk)}">${esc(p.name)}</b>`);
  // the ships carry their names now; the line only says we're waiting
  $("#home-fleet").hidden = names.length > 0;
  $("#home-fleet").innerHTML = names.length
    ? `⚓ ${names.length} aboard: ${names.slice(0, 14).join(" · ")}${names.length > 14 ? ` +${names.length - 14} more` : ""}`
    : `<i>Waiting for the first pirate…</i>`;
}

/** Between rounds: get ready for the next one. */
function lobby(s: PubState) {
  const box = $("#lobby");
  box.hidden = s.phase !== "lobby" || !$("#home").hidden;
  if (box.hidden) return;
  box.innerHTML = `<div class="gr-small">GET READY FOR</div><div class="gr-big">${esc(upNext(s).toUpperCase())}</div>${wheelsOffNow(s) ? `<p class="b-wheels">🚲 No more date training wheels: just guess the <b>BLOCK HEIGHT</b>!</p>` : `<p class="b-ready">Shoot the wall, then guess the <b>BLOCK HEIGHT</b>.</p>`}`;
}

/** A round is over: the answer and the best guesses. After the last round: the winner. */
function final(s: PubState) {
  const box = $("#final");
  if (!s.final) box.hidden = true;
  if (!s.final) {
    lastFinal = "";
    return;
  }
  if (lastFinal === s.gameId) return;
  lastFinal = s.gameId;
  const f = s.final;
  // a second to see the revealed picture, then the card, which stays until the next round loads
  clearTimeout(finalTimer);
  clearTimeout(revealTimer);
  box.hidden = true;
  revealTimer = window.setTimeout(() => {
    box.hidden = false;
    // it stays up until the host loads the next round
  }, 1000);
  const name = (pk: string) => `<b style="color:${playerColor(pk)}">${esc(s.players[pk]?.name ?? "")}</b>`;
  if (f.showOver || f.stage === "final") {
    const top = f.ranking.slice(0, 3);
    const w = top[0];
    box.innerHTML = `${pirateConfetti(60)}
      <div class="final-card b-champion">
        <div class="bc-hero">
          <img class="bc-belt" src="/badges/belt.png" alt="">
          <div>
            <div class="bc-kicker">🏆 YOUR CHAMPION 🏆</div>
            ${w ? `<div class="bc-name" style="color:${playerColor(w.pk)}">${shipIcon(playerColor(w.pk), "ship", { picture: s.players[w.pk]?.picture, leader: true })}<span>${esc(s.players[w.pk]?.name ?? "")}</span></div>
            <div class="bc-prize">wins <b>${fmt(w.share)} sats</b> and the <b>Bitcoin Ship Show Hardcore Championship Belt</b></div>` : `<div class="bc-name">Nobody scored!</div>`}
          </div>
        </div>
        <div class="bc-side">
          <div class="bc-answer">${esc(f.event ?? s.puzzleTitle)}, the block height was <b>${fmt(f.height ?? 0)}</b></div>
          <ol class="bc-rest">${top.slice(1).map((r, i) => `<li><span>${i + 2}.</span> ${name(r.pk)} <b>${r.points} pts</b></li>`).join("")}</ol>
        </div>
      </div>`;
    return;
  }
  const best = (f.guesses ?? []).slice(0, 5);
  const winner = best[0];
  // first place overall, counting this round
  const leader = Object.keys(s.players).sort((a, b) => showPoints(s, b) - showPoints(s, a))[0];
  box.innerHTML = `${pirateConfetti(30)}<div class="final-card b-result b-splash">
      <div class="b-s-answer">
        <div class="b-s-event">${esc(f.event ?? s.puzzleTitle)}, the block height was</div>
        <div class="b-r-answer">${fmt(f.height ?? 0)}</div>
        <div class="b-r-date">${f.when ? dayMonthYear(Date.parse(f.when)) : ""}</div>
      </div>
      <div class="b-s-tiles">
        <div class="b-s-tile"><small>🏆 ROUND WINNER</small>${winner ? `<b style="color:${playerColor(winner.pk)}">${esc(s.players[winner.pk]?.name ?? "")}</b><span>${fmt(winner.height)} · off by ${fmt(Math.abs(winner.off))} · +${winner.points}</span>` : "<b>Nobody!</b><span>no guesses locked in</span>"}</div>
        <div class="b-s-tile"><small>⚓ FIRST PLACE OVERALL</small>${leader ? `<b style="color:${playerColor(leader)}">${esc(s.players[leader]?.name ?? "")}</b><span>${showPoints(s, leader)} pts</span>` : "<b>—</b>"}</div>
      </div>
      </div>
    </div>`;
}

/**
 * The join screen's fleet: each ship sails its own loop around the open lagoon on the left.
 * Nearer lanes are lower and bigger; a big crowd shrinks a little so it stays a fleet.
 */
function sailHome() {
  const box = document.getElementById("home-ships");
  if (box && !document.getElementById("home")!.hidden) {
    const ships = [...box.children] as HTMLElement[];
    const shrink = Math.max(0.72, Math.min(1, 14 / Math.max(1, ships.length)));
    const t = performance.now() / 1000;
    const order: [number, HTMLElement][] = [];
    for (const el of ships) {
      const slot = Number(el.dataset.slot);
      const r = (k: number) => {
        const v = Math.sin((slot + 1) * 12.9898 + k * 78.233) * 43758.5453;
        return v - Math.floor(v);
      };
      const lane = (slot * 0.618 + 0.2 * r(1)) % 1;
      const period = 26 + 22 * r(2);
      const a = (t / period) * Math.PI * 2 + slot * 2.4;
      const x = 2 + (0.5 + 0.5 * Math.sin(a)) * (30 - 4 * lane); // % of the screen width
      const y = 60 + lane * 28 + 1.2 * Math.sin(t * 1.3 + slot); // % of the height
      const scale = (0.7 + 0.5 * lane) * shrink;
      el.style.transform = `translate(${x.toFixed(2)}vw, ${y.toFixed(2)}vh) scale(${scale.toFixed(3)})`;
      (el.firstElementChild as HTMLElement).style.transform = Math.cos(a) >= 0 ? "" : "scaleX(-1)";
      order.push([y, el]);
    }
    order.sort((p, q) => p[0] - q[0]).forEach(([, el], i) => (el.style.zIndex = String(i + 1)));
  }
  requestAnimationFrame(sailHome);
}
requestAnimationFrame(sailHome);
