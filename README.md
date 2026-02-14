# turnstile-solver

Cloudflare Turnstile auto-solver using ghost-cursor mouse simulation.

Solves Turnstile challenges by locating the cross-origin iframe, computing the checkbox coordinates from its bounding box, and clicking with Bezier-curve mouse movement that follows Fitts's Law timing.

## Install

```bash
bun add github:mrvnklm/playwright-turnstile-solver
```

## Usage

```typescript
import { solveTurnstile, raceContentOrTurnstile, enableTurnstileScreenshots } from 'turnstile-solver'

// Optional: enable debug screenshots
enableTurnstileScreenshots('/tmp/turnstile-debug')

// Standalone: solve a Turnstile challenge on the current page
const solved = await solveTurnstile(page, console.log)

// Race: detect whether content loaded or Turnstile appeared
const result = await raceContentOrTurnstile(page, '#main-content', console.log)
// result: 'content' | 'solved' | 'blocked'
```

## API

### `solveTurnstile(page, log?)`

Waits for a Turnstile iframe, then clicks the checkbox with human-like mouse movement. Returns `true` if solved, `false` if no challenge found or all attempts failed.

### `raceContentOrTurnstile(page, contentSelector, log?)`

Races content loading against Turnstile detection. Use after `page.goto()` to avoid wasting time waiting for content timeouts when a challenge is present.

Returns `'content'` | `'solved'` | `'blocked'`.

### `enableTurnstileScreenshots(dir?)`

Enables debug screenshots at each stage of the solve process. Defaults to a temp directory.

## Compatibility

Works with any Playwright-compatible browser automation library:

- `playwright`
- `playwright-core`
- `patchright` (Playwright fork)

The `Page` type is from `playwright-core` (peer dependency, optional). Patchright and Playwright extend the same interface, so all are compatible at runtime.

## License

Private — internal use only.
