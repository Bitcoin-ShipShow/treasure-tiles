// Plays a free-for-all in the test lab (drag-to-fire on the phones) and saves screenshots.
// Usage: server running; TOKEN=$(cat data/host-token.txt) CHROME=... tsx test/ui-solo.mjs
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.CHROME });
const page = await b.newPage({ viewport: { width: 1680, height: 1050 } });
const errs = [];
page.on("pageerror", (e) => errs.push("lab: " + e.message));
await page.goto("http://localhost:8090/lab");
await page.fill("#pw", process.env.TOKEN);
await page.click("#login button");
await page.waitForTimeout(3000);
for (const f of page.frames()) f.page().on("pageerror", (e) => errs.push("frame: " + e.message));
await page.screenshot({ path: "test-results/solo-lab-lobby.png" });
await page.click("#bots-add");
await page.waitForTimeout(300);
await page.waitForTimeout(500);
await page.click("#start");
await page.waitForTimeout(1500);
// Drag-to-fire on phone 1 and phone 2: grab the wall, pull down
for (const seat of [1, 2, 3]) {
  const frame = page.frameLocator(`#seat-${seat} iframe`);
  const wall = frame.locator(".cove");
  const box = await wall.boundingBox();
  for (const [dx, dy] of [[0, 60], [-15, 90], [20, 40], [5, 15]]) {
    const x = box.x + box.width / 2, y = box.y + box.height * 0.4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(1150);
  }
}
const readouts = [];
for (const seat of [1, 2, 3]) readouts.push(await page.frameLocator(`#seat-${seat} iframe`).locator("#aim-readout").textContent());
console.log(readouts);
await page.locator("#answer-words .chip").nth(4).click(); // BEAR into ticked phone 1
await page.frameLocator("#seat-1 iframe").locator("#fire").click();
await page.waitForTimeout(400);
await page.screenshot({ path: "test-results/solo-lab-play.png" });
// full board in its own tab, mid-game
const board = await b.newPage({ viewport: { width: 1920, height: 1080 } });
board.on("pageerror", (e) => errs.push("board: " + e.message));
await board.goto("http://localhost:8090/board");
await board.waitForTimeout(2500);
await board.screenshot({ path: "test-results/solo-board.png" });
const phone = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
phone.on("pageerror", (e) => errs.push("phone: " + e.message));
await phone.goto("http://localhost:8090/play?seat=9&name=Phoney");
await phone.waitForTimeout(2500);
await phone.screenshot({ path: "test-results/solo-phone.png" });
// solve it from phone 2
await page.click('[data-target="2"]');
await page.locator("#answer-words .chip.whole").click();
await page.frameLocator("#seat-2 iframe").locator("#fire").click();
await page.waitForTimeout(2500);
await board.screenshot({ path: "test-results/solo-board-final.png" });
await page.screenshot({ path: "test-results/solo-lab-final.png" });
console.log("errors:", errs);
await b.close();
