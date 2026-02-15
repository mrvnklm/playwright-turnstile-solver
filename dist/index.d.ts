import { Page } from 'playwright-core';

/**
 * Cloudflare Turnstile auto-solver via ghost-cursor mouse simulation.
 *
 * Turnstile renders its checkbox in a cross-origin sandboxed iframe,
 * so direct DOM access is impossible. Instead we:
 *  1. Locate the iframe element on the parent page
 *  2. Get its bounding box (works without cross-origin access)
 *  3. Use ghost-cursor to move the mouse along a Bezier curve to the
 *     checkbox coordinates (~24-40px from left, vertically centered)
 *  4. Click with human-like hesitation
 *
 * ghost-cursor generates Fitts's Law-timed Bezier paths that are
 * indistinguishable from real human mouse movement.
 */

type LogFn = (msg: string) => void;
declare function enableTurnstileScreenshots(dir?: string): void;
/**
 * Attempt to solve a Cloudflare Turnstile challenge on the current page.
 *
 * @returns true if the challenge was solved, false if no challenge was
 *          found or all attempts failed.
 */
declare function solveTurnstile(page: Page, log?: LogFn): Promise<boolean>;
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
declare function raceContentOrTurnstile(page: Page, contentSelector: string, log?: LogFn): Promise<'content' | 'solved' | 'blocked'>;

export { enableTurnstileScreenshots, raceContentOrTurnstile, solveTurnstile };
