# Overlook

A Manifest V3 new-tab extension for Chromium browsers (minimum Chrome 120): bookmarks in folders, a Spotlight-style search, sharp cached site icons and a background that can follow the sun. Plain TypeScript, no framework, **no runtime dependencies**. README.md is for people who install and use Overlook; developer material belongs here.

## Commands

```sh
npm run check          # typecheck, lint, format check, unit tests with coverage, e2e: run before calling work done
npm test               # unit tests (Vitest, happy-dom), colocated as src/**/*.test.ts
npm run test:e2e       # builds dist/, then Playwright drives the real extension in Chromium
npm run build          # dist/ is the unpacked extension
npm run dev            # rebuild dist/ on every change
npm run preview        # build, then open a separate Chromium window with sample bookmarks
npm run fix            # eslint --fix, then prettier --write
npm run deps:update    # npm-check-updates --peer, npm install, playwright install, npm audit, then check
```

Node 24+ (`engines`). The first e2e run needs `npx playwright install chromium`. Coverage thresholds are in `vite.config.ts`.

## Layout

- `src/newtab.html` loads `src/focus-step.ts` first, as a plain (non-module) script, then `src/main.ts`, the page entry, which starts `src/app.ts`, where the new-tab page is wired together. `src/styles.css` is the one stylesheet.
- `src/background.ts`: the service worker (icon sync, and the `wallpaperInstalled` check). `tsconfig.json` holds the shared options; `tsconfig.app.json` covers `src/`, `tsconfig.worker.json` the service worker (WebWorker types), and `tsconfig.node.json` the configs and `tests/e2e/` with Node's own resolution, so relative imports there need explicit `.ts` extensions (node runs `tests/e2e/preview.ts` directly).
- `src/bookmarks/`: builds the folder model from `chrome.bookmarks.getTree()`. Permanent roots are hidden: their subfolders become top-level folders, and their loose bookmarks a folder named after the root. Only allow-listed URL protocols are kept.
- `src/private-network.ts`: `isPrivateNetworkHost`, used by the icon fetch guard and the VPN label.
- `src/search/`: the fuzzy search index (prefix, typo, acronym, substring and subsequence matching, plus a usage boost) and accent-folding text helpers.
- `src/favicons/`: icon discovery (a regex `<link>` scanner, because service workers have no `DOMParser`), fetching, normalising to 128px PNG, the icon records and the service-worker sync queue.
- `src/storage/`: the shared IndexedDB (`icons` and `files` stores).
- `src/backgrounds/`: the bundled photos (AVIF), the custom upload and the background view. `src/wallpaper/`: the dynamic wallpaper end to end: manifest parsing, frame schedule, sun position and the time-zone table.
- `src/settings/`, `src/labels/`: validated settings in `chrome.storage.local`, and the label rules (host globs, private-network flag).
- `src/home/`: what Home shows (favourites, frequent links or a folder). `src/usage/`: decaying scores for links opened from Overlook, in `chrome.storage.local`.
- `src/validation.ts`: shared type-guard helpers (`isRecord`, `isOneOf`, `isFiniteNumber`). `src/log.ts`: `warn` / `warnOnFailure`.
- `src/ui/`: DOM components, all built with `h()` from `src/ui/dom.ts`. `shortcuts.ts` binds the global keys and `panel-events.ts` the panel's click and drag delegation. `src/test/`: the sample library for unit tests.
- `src/icons/`: the SVG sources of the extension icon (not shipped).
- `public/`: `manifest.json`, `icons/` (the PNGs), `backgrounds/` (photos, thumbs and `CREDITS.txt`, the Unsplash notice that ships in the zip), `wallpapers/` (the user's own frames and manifest, git-ignored).
- `tests/e2e/`: Playwright fixtures, a fake-site server, sample bookmarks, the specs and `preview.ts`.
- `.github/`: CI and release workflows, the `package-extension` action, Dependabot, SECURITY.md and `screenshot.jpg` (the README image).

Generated files that are committed, with no generator in the repo:

- `src/wallpaper/timezone-coordinates.ts`: IANA `zone.tab` coordinates per zone, plus the tz database's aliases. Edit it by hand if a zone is missing.
- `public/icons/icon-{16,32,48,128}.png`: rendered once from `src/icons/icon.svg` (and `icon-16.svg` for the smallest size). Re-render all four after changing the SVG.

## Rules

- **Never insert HTML strings.** Use `h()`, `textContent` or `setAttribute`: bookmark titles are untrusted. The CSP enforces Trusted Types, so `innerHTML` would throw anyway.
- **Treat storage, IndexedDB, messages and fetched data as `unknown`** and validate them with type guards built on `src/validation.ts`. See `parseSettings`, `parseManifest`, `isIconRecord` and `isIconMessage`.
- **Network safety:** icons may only be fetched from the bookmarked site's own origin or from public hosts (`isPermittedIconUrl`). Cross-origin icon and manifest fetches must not follow redirects, and for a public site they must be `https` (a public name can resolve to a LAN address, but a LAN device can't present a valid certificate for it). Same-origin ones may, but for a public site a response that ends on a private host is discarded. Keep size caps, timeouts, `credentials: "omit"` and `referrerPolicy: "no-referrer"`. README's privacy section summarises this, so keep it accurate.
- **No new runtime dependencies.** Dev dependencies are pinned to exact versions.
- **TypeScript runs strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Don't use `any`, `!` or `@ts-ignore`. Use ESM named exports.
- **Few comments**, and only for the non-obvious _why_.
- **Test data stays neutral** ("Acme", "Work", example.com). The repo is public.
- **Never commit `public/wallpapers/`**: the frames are usually Apple's artwork, and the folder is git-ignored.
- **Permissions:** if you change `public/manifest.json` permissions, update the permissions table in README.md.
- **Keyboard shortcuts:** the README table mirrors `src/ui/shortcuts.ts`, `src/ui/spotlight.ts` and `src/ui/navigation.ts`. Update it with them.
- **Wallpaper manifest:** README's "Dynamic wallpaper" section documents the format `parseManifest` accepts. Change them together.

## Gotchas

- **Keyboard focus on a new tab** (`src/focus-step.ts`): Chromium gives it to the address bar and the new-tab page can't take it back.
  - How: after `load`, the page steps forward to `newtab.html?focus` (a page the tab navigated to may take focus), then `history.back()`, which keeps the focus and empties the address bar. Navigating before `load` turns into a replace. The setting is mirrored to `localStorage` (the same key literal in `focus-step.ts` and `main.ts`) because the script can't wait for `chrome.storage`.
  - Why it works: `chrome/browser/ui/focus_tab_after_navigation_helper.cc` focuses the page on a page-initiated navigation away from the new-tab page; `chrome.tabs.update` is excluded on purpose (crbug.com/40693812).
  - Doesn't work: `focus()` alone, `document.hasFocus()` as a check, `pushState`, `location.reload()`, navigating or `chrome.tabs.update` to `chrome://newtab`. Only a real Cmd+T shows the effect.
- **The manifest `key` fixes the extension ID** (`imabhmapeefoacmhgemijamhnfcnbdoa`), whatever folder the unpacked extension is loaded from, so updates keep users' data. Only the public key is in the repo; there is no private key because nothing is packed as a .crx.
- **The dynamic wallpaper is detected once:** a missing extension file can't be fetched without a console error, so `background.ts` checks for `wallpapers/manifest.json` on install and start-up and stores `wallpaperInstalled`; pages fetch the manifest only when it's `true`. After adding frames, reload the extension.
- **`npm run preview` clears the profile's cached service worker:** Chromium otherwise keeps running an old copy of an unpacked extension's background script across launches.
- **TypeScript is pinned to 6.0.x:** typescript-eslint supports only TS < 6.1. `deps:update` (`--peer`) holds it back; Dependabot ignores TypeScript 6.1 and later. Dependabot also ignores `@types/node` majors, which follow `engines`.
- **Font size:** Chromium's extension-page stylesheet shrinks body text to 75%, so type is set on `body`, not `:root`.
- **Wallpaper frames are chosen by the sun's altitude**, with azimuth only telling morning from evening (`src/wallpaper/schedule.ts`): schedules are shot at one latitude, and full sky position breaks elsewhere (Nordic summer sunrise is in the north-east). Location comes only from the time zone (`timezone-coordinates.ts`), never from geolocation.
- **Settings use `storage.local`:** `storage.sync` caps items at 8 KB, which labels exceed. A custom background carries `savedAt`, so replacing the image is a real settings change that every tab sees.
- **Build warning:** Vite's `<script src="./focus-step.js"> ... can't be bundled without type="module"` is expected. `focus-step.js` is its own entry, loaded as a classic `<head>` script so it runs before the page renders.
- **Service-worker lifetime:** Chrome stops idle extension service workers after 30 s, and fetches don't count as activity. `background.ts` pings an extension API while a sync runs.
- **e2e browser setup** (`tests/e2e/fixtures.ts`):
  - Tests take the extension ID from the service worker URL.
  - Chromium starts with `--host-resolver-rules=MAP public.example.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, so tests never reach the internet. `context.route` answers every other http(s) host with a stub page. `FakeSites` serves on 127.0.0.1 and on `public.example.com`, a host the extension treats as public (used by the redirect test).
  - Fixture options: `wallpaper` is `fixture` (default, 1×1 frames), `none` (no wallpaper, so the default photo) or `real` (your own frames from `public/wallpapers/`, copied into `dist/` by the build); `focusStep` (default `false`) turns the focus step off, because it races most tests; set it to `true` (as the focus tests in `newtab.spec.ts` do) to let it run.
  - `chrome.runtime.reload()` unloads an extension loaded with `--load-extension` for good. To rerun the start-up sync, use the `restartBrowser` fixture, which relaunches on the same profile.
  - `visual.spec.ts` and the window-width review in `responsive.spec.ts` (`@visual`) write review screenshots to `test-results/`. CI skips `@visual` and retries failures once.

## CI and releases

The workflows in `.github/workflows/` say what runs. Two things they can't:

- **Private vulnerability reporting** must be turned on in the repository settings (Settings → Code security) before the repo goes public, and stay on: SECURITY.md sends reporters to the Security tab's **Report a vulnerability** button, which only exists while it's enabled.
- The release workflow fails unless the tag matches `version` in both `package.json` and `public/manifest.json`.

To release:

1. Run `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`), then set the same `version` in `public/manifest.json`. Skip this for v0.1.0: both files already say 0.1.0.
2. Run `npm run check`.
3. Commit, push main, then push a tag `vX.Y.Z` (`git tag v0.2.0 && git push origin v0.2.0`).
