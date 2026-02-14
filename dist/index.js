// src/solver.ts
import { createCursor } from "ghost-cursor-playwright-port";
import { mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
var TURNSTILE_IFRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"]';
var MAX_ATTEMPTS = 3;
var WAIT_FOR_IFRAME_MS = 1e4;
var WAIT_FOR_RESOLVE_MS = 15e3;
var screenshotDir = null;
var screenshotCounter = 0;
function enableTurnstileScreenshots(dir) {
  screenshotDir = dir ?? join(tmpdir(), "turnstile-screenshots");
  mkdirSync(screenshotDir, { recursive: true });
}
async function screenshot(page, label, info) {
  if (!screenshotDir) return;
  try {
    const filename = `${String(++screenshotCounter).padStart(3, "0")}-${label}.png`;
    const path = join(screenshotDir, filename);
    await page.screenshot({ path, fullPage: false });
    info(`Screenshot: ${path}`);
  } catch (err) {
    info(`Screenshot failed (${label}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function solveTurnstile(page, log) {
  const info = (msg) => log?.(`[turnstile] ${msg}`);
  info("Waiting for Turnstile iframe...");
  const iframe = await page.waitForSelector(TURNSTILE_IFRAME_SELECTOR, { timeout: WAIT_FOR_IFRAME_MS }).catch(() => null);
  if (!iframe) {
    info("No Turnstile iframe found");
    return false;
  }
  return clickTurnstileCheckbox(page, iframe, info);
}
async function raceContentOrTurnstile(page, contentSelector, log) {
  const info = (msg) => log?.(`[turnstile] ${msg}`);
  const result = await Promise.race([
    // Path A: content loaded normally
    page.waitForSelector(contentSelector, { timeout: 3e4 }).then(() => "content").catch(() => "timeout"),
    // Path B: Turnstile iframe detected — solve it
    page.waitForSelector(TURNSTILE_IFRAME_SELECTOR, { timeout: 3e4 }).then(async (iframe) => {
      info("Turnstile detected, solving...");
      const solved = await clickTurnstileCheckbox(page, iframe, info);
      return solved ? "solved" : "blocked";
    }).catch(() => "no-turnstile")
  ]);
  if (result === "content") return "content";
  if (result === "solved") return "solved";
  if (result === "blocked") return "blocked";
  info("Neither content nor Turnstile detected in race, checking once more...");
  const lateIframe = await page.$(TURNSTILE_IFRAME_SELECTOR);
  if (lateIframe) {
    const solved = await clickTurnstileCheckbox(page, lateIframe, info);
    return solved ? "solved" : "blocked";
  }
  return "blocked";
}
async function isTurnstileResolved(page) {
  const iframe = await page.$(TURNSTILE_IFRAME_SELECTOR).catch(() => null);
  if (!iframe) return true;
  const hasToken = await page.evaluate(() => {
    const input = document.querySelector('[name="cf-turnstile-response"]');
    return input !== null && input.value.length > 0;
  }).catch(() => false);
  return hasToken;
}
async function waitForTurnstileResolution(page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isTurnstileResolved(page)) return true;
  }
  return false;
}
async function clickTurnstileCheckbox(page, iframe, info) {
  const box = await iframe.boundingBox();
  if (!box) {
    info("Could not get iframe bounding box");
    return false;
  }
  info(`Iframe bounds: ${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.width.toFixed(0)}x${box.height.toFixed(0)}`);
  info("Waiting for widget to become interactive...");
  for (let waited = 0; waited < 5e3; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isTurnstileResolved(page)) {
      info("Page resolved during managed check \u2014 no click needed");
      await screenshot(page, "managed-resolve", info);
      return true;
    }
  }
  await screenshot(page, "widget-ready", info);
  const cursor = createCursor(page);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const freshBox = await iframe.boundingBox() ?? box;
    const clickX = freshBox.x + 28 + Math.random() * 8;
    const clickY = freshBox.y + freshBox.height / 2 - 2 + Math.random() * 4;
    info(`Attempt ${attempt}: moving to (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
    await screenshot(page, `before-click-${attempt}`, info);
    await cursor.moveTo({ x: clickX, y: clickY });
    const hesitateMs = 200 + Math.random() * 300;
    await new Promise((r) => setTimeout(r, hesitateMs));
    await page.mouse.click(clickX, clickY);
    await screenshot(page, `after-click-${attempt}`, info);
    await new Promise((r) => setTimeout(r, 2e3));
    await screenshot(page, `after-delay-${attempt}`, info);
    const resolved = await waitForTurnstileResolution(page, WAIT_FOR_RESOLVE_MS);
    if (resolved) {
      await screenshot(page, "solved", info);
      info("Turnstile solved!");
      return true;
    }
    info(`Attempt ${attempt} did not resolve, retrying...`);
  }
  info("Failed to solve after 3 attempts");
  return false;
}
export {
  enableTurnstileScreenshots,
  raceContentOrTurnstile,
  solveTurnstile
};
