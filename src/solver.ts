/**
 * Cloudflare Turnstile auto-solver via ghost-cursor mouse simulation.
 *
 * Turnstile renders its checkbox in a cross-origin sandboxed iframe,
 * so direct DOM access is impossible. Instead we:
 *  1. Locate the iframe element on the parent page
 *  2. Get its bounding box (works without cross-origin access)
 *  3. Use ghost-cursor to move the mouse along a Bezier curve to the
 *     checkbox coordinates (~28-36px from left, vertically centered)
 *  4. Click with human-like hesitation
 *
 * ghost-cursor generates Fitts's Law-timed Bezier paths that are
 * indistinguishable from real human mouse movement.
 */

import { createCursor } from 'ghost-cursor-playwright-port'
import type { Page } from 'playwright-core'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

type LogFn = (msg: string) => void

const TURNSTILE_IFRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"]'
const MAX_ATTEMPTS = 3
const WAIT_FOR_IFRAME_MS = 10_000
const WAIT_FOR_RESOLVE_MS = 15_000

/** Enable screenshots for debugging (set via enableTurnstileScreenshots) */
let screenshotDir: string | null = null
let screenshotCounter = 0

export function enableTurnstileScreenshots(dir?: string): void {
  screenshotDir = dir ?? join(tmpdir(), 'turnstile-screenshots')
  mkdirSync(screenshotDir, { recursive: true })
}

async function screenshot(page: Page, label: string, info: (msg: string) => void): Promise<void> {
  if (!screenshotDir) return
  try {
    const filename = `${String(++screenshotCounter).padStart(3, '0')}-${label}.png`
    const path = join(screenshotDir, filename)
    await page.screenshot({ path, fullPage: false })
    info(`Screenshot: ${path}`)
  } catch (err) {
    info(`Screenshot failed (${label}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Attempt to solve a Cloudflare Turnstile challenge on the current page.
 *
 * @returns true if the challenge was solved, false if no challenge was
 *          found or all attempts failed.
 */
export async function solveTurnstile(
  page: Page,
  log?: LogFn,
): Promise<boolean> {
  const info = (msg: string) => log?.(`[turnstile] ${msg}`)

  // 1. Wait for Turnstile iframe to appear
  info('Waiting for Turnstile iframe...')
  const iframe = await page
    .waitForSelector(TURNSTILE_IFRAME_SELECTOR, { timeout: WAIT_FOR_IFRAME_MS })
    .catch(() => null)

  if (!iframe) {
    info('No Turnstile iframe found')
    return false
  }

  return clickTurnstileCheckbox(page, iframe, info)
}

/**
 * Race between normal page content loading and Turnstile challenge detection.
 *
 * Call this right after page.goto(). It runs two checks in parallel:
 *  - Wait for the content selector (page loaded normally)
 *  - Watch for the Turnstile iframe and solve it if found
 *
 * @returns 'content' if page loaded normally, 'solved' if Turnstile was solved,
 *          'blocked' if Turnstile appeared but couldn't be solved.
 */
export async function raceContentOrTurnstile(
  page: Page,
  contentSelector: string,
  log?: LogFn,
): Promise<'content' | 'solved' | 'blocked'> {
  const info = (msg: string) => log?.(`[turnstile] ${msg}`)

  // Race: content appears vs Turnstile iframe appears
  const result = await Promise.race([
    // Path A: content loaded normally
    page
      .waitForSelector(contentSelector, { timeout: 30_000 })
      .then(() => 'content' as const)
      .catch(() => 'timeout' as const),

    // Path B: Turnstile iframe detected — solve it
    page
      .waitForSelector(TURNSTILE_IFRAME_SELECTOR, { timeout: 30_000 })
      .then(async (iframe) => {
        info('Turnstile detected, solving...')
        const solved = await clickTurnstileCheckbox(page, iframe, info)
        return solved ? ('solved' as const) : ('blocked' as const)
      })
      .catch(() => 'no-turnstile' as const),
  ])

  if (result === 'content') return 'content'
  if (result === 'solved') return 'solved'
  if (result === 'blocked') return 'blocked'

  // Both timed out — neither content nor Turnstile appeared.
  // Fall back to a quick Turnstile check (might have loaded after the race).
  info('Neither content nor Turnstile detected in race, checking once more...')
  const lateIframe = await page
    .$(TURNSTILE_IFRAME_SELECTOR)
  if (lateIframe) {
    const solved = await clickTurnstileCheckbox(page, lateIframe, info)
    return solved ? 'solved' : 'blocked'
  }

  return 'blocked'
}

/**
 * Check if the Turnstile challenge has resolved.
 *
 * Uses only stable, light-DOM selectors that work universally across all
 * Cloudflare-protected sites regardless of locale or CSS class changes:
 *
 *  1. `[name="cf-turnstile-response"]` — Turnstile's form contract token input.
 *     Present from page load with empty value; populated when solved.
 *  2. `script[src*="/cdn-cgi/challenge-platform/"]` — Cloudflare's challenge
 *     orchestrator script in `<head>`, present on all challenge pages.
 *
 * The Turnstile iframe itself lives inside a **closed Shadow DOM**, so
 * `document.querySelector('iframe[src*="challenges.cloudflare.com"]')`
 * always returns null from page context. These light-DOM selectors avoid
 * that limitation entirely.
 */
async function isTurnstileResolved(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // 1. Token populated → definitely solved
    const tokenInput = document.querySelector(
      '[name="cf-turnstile-response"]'
    ) as HTMLInputElement | null
    if (tokenInput && tokenInput.value.length > 0) return true

    // 2. Challenge platform script still in <head> → challenge page active
    const challengeScript = document.querySelector(
      'script[src*="/cdn-cgi/challenge-platform/"]'
    )
    if (challengeScript) return false

    // 3. Token input exists but empty → still solving
    if (tokenInput) return false

    // 4. No token input, no challenge script → page navigated away
    return true
  }).catch(() => {
    // page.evaluate failed — page likely navigated (= resolved)
    return true
  })
}

/**
 * Poll for Turnstile resolution with timeout.
 * Uses isTurnstileResolved() for language-independent detection.
 */
async function waitForTurnstileResolution(page: Page, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    if (await isTurnstileResolved(page)) return true
  }
  return false
}

/**
 * Click the Turnstile checkbox using ghost-cursor Bezier movement.
 * Retries up to MAX_ATTEMPTS times with slight coordinate jitter.
 */
async function clickTurnstileCheckbox(
  page: Page,
  iframe: NonNullable<Awaited<ReturnType<Page['waitForSelector']>>>,
  info: (msg: string) => void,
): Promise<boolean> {
  const box = await iframe.boundingBox()
  if (!box) {
    info('Could not get iframe bounding box')
    return false
  }

  info(`Iframe bounds: ${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.width.toFixed(0)}x${box.height.toFixed(0)}`)

  // Wait for the Turnstile widget to transition from "Verifying..." spinner
  // to the interactive "Verify you are human" checkbox (~3-5s).
  // The managed check runs automatically first — if it passes, the page
  // redirects with no click needed. If it fails, the checkbox appears.
  // We poll for iframe disappearance to detect early resolution (language-independent).
  info('Waiting for widget to become interactive...')
  for (let waited = 0; waited < 5000; waited += 500) {
    await new Promise(r => setTimeout(r, 500))
    if (await isTurnstileResolved(page)) {
      info('Page resolved during managed check — no click needed')
      await screenshot(page, 'managed-resolve', info)
      return true
    }
  }

  await screenshot(page, 'widget-ready', info)

  const cursor = createCursor(page as any)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Re-read bounding box in case iframe moved during loading
    const freshBox = await iframe.boundingBox() ?? box

    // Checkbox is ~28-36px from left edge, vertically centered in iframe
    const clickX = freshBox.x + 28 + Math.random() * 8
    const clickY = freshBox.y + freshBox.height / 2 - 2 + Math.random() * 4
    info(`Attempt ${attempt}: moving to (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`)

    await screenshot(page, `before-click-${attempt}`, info)

    // Bezier curve movement with Fitts's Law timing
    await cursor.moveTo({ x: clickX, y: clickY })

    // Human-like hesitation before clicking (200-500ms)
    const hesitateMs = 200 + Math.random() * 300
    await new Promise((r) => setTimeout(r, hesitateMs))

    // Click at current position via page.mouse (works across iframe boundaries)
    await page.mouse.click(clickX, clickY)

    await screenshot(page, `after-click-${attempt}`, info)

    // Wait a moment for the widget to react, then capture state
    await new Promise((r) => setTimeout(r, 2000))
    await screenshot(page, `after-delay-${attempt}`, info)

    // Wait for challenge resolution — iframe disappears when solved (language-independent)
    const resolved = await waitForTurnstileResolution(page, WAIT_FOR_RESOLVE_MS)

    if (resolved) {
      await screenshot(page, 'solved', info)
      info('Turnstile solved!')
      return true
    }

    info(`Attempt ${attempt} did not resolve, retrying...`)
  }

  info('Failed to solve after 3 attempts')
  return false
}
