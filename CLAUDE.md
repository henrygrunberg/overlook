# Overlook

A Manifest V3 new-tab extension for Chromium browsers (minimum Chrome 137): bookmarks in folders, a Spotlight-style search, sharp cached site icons and a background that can follow the sun. Plain TypeScript, no framework, **no runtime dependencies**. README.md is for people who install and use Overlook; developer material belongs here.

## Commands

```sh
npm run check          # typecheck, lint, format check, unit tests with coverage, e2e: run before calling work done
npm test               # unit tests (Vitest, happy-dom) in tests/unit/, which mirrors src/
npm run test:e2e       # builds dist/, then Playwright drives the real extension in Chromium
npm run build          # dist/ is the unpacked extension
npm run dev            # rebuild dist/ on every change
npm run preview        # build, then open a separate Chromium window with sample bookmarks
npm run fix            # eslint --fix, then prettier --write
npm run deps:update    # npm-check-updates (--peer, 7-day cooldown, @types/node minor only), npm install, playwright install, npm audit, then check
```

Node 24+ (`engines`). The first e2e run needs `npx playwright install chromium`. Coverage thresholds are in `vite.config.ts`.

## Layout

- `src/newtab.html` loads `src/focus-step.ts` first, as a plain (non-module) script, then `src/main.ts`, the page entry, which starts `src/app.ts`, where the new-tab page is wired together. Its body starts with the skip link and ends with `#announcer`, the polite live region `app.ts` writes status text to. `src/styles.css` is the one stylesheet.
- `src/service-worker.ts`: the service worker, built as `background.js` (icon sync, and the `wallpaperInstalled` check). `tsconfig.json` holds the shared options; `tsconfig.app.json` covers `src/` and `tests/unit/`, `tsconfig.worker.json` the service worker (WebWorker types; the worker's unit test imports it, so it must type-check with the DOM types of the app project too), and `tsconfig.node.json` the configs and `tests/e2e/` with Node's own resolution, so relative imports there need explicit `.ts` extensions (node runs `tests/e2e/preview.ts` directly).
- `src/bookmarks/`: builds the folder model from `chrome.bookmarks.getTree()`. Permanent roots are hidden: their subfolders become top-level folders, and their loose bookmarks a folder named after the root. Only allow-listed URL protocols are kept.
- `src/private-network.ts`: `isPrivateNetworkHost` and `isPrivateOrigin`, used by the icon fetch guard, the icon sync's private pass and the VPN label.
- `src/search/`: the fuzzy search index (prefix, typo, acronym, substring and subsequence matching, plus a usage boost) and accent-folding text helpers.
- `src/favicons/`: icon discovery (a small linear tag scanner, because service workers have no `DOMParser`: it skips comments and raw text such as `<script>`, and honours `<base href>`), fetching, normalising to 128px PNG, the icon records, the service-worker sync queue and `private-origin-rules.ts` (see the network gotcha).
- `src/storage/`: the shared IndexedDB (`icons` and `files` stores).
- `src/backgrounds/`: the bundled photos' names and credits (`photos.ts`; the files are in `public/backgrounds/`) and the custom upload. `src/wallpaper/`: the dynamic wallpaper end to end: manifest parsing, frame schedule, sun position, the time-zone table and `wallpaper-flag.ts`, the paths and storage key the service worker and pages share.
- `src/settings/`, `src/labels/`: validated settings in `chrome.storage.local`, and the label rules (host globs, private-network flag).
- `src/home/`: what Home shows (favourites, frequent links or a folder). `src/usage/`: decaying scores for links opened from Overlook, in `chrome.storage.local`.
- `src/validation.ts`: shared type-guard helpers (`isRecord`, `isOneOf`, `isFiniteNumber`) and `parseHttpUrl`. `src/log.ts`: `warn` / `warnOnFailure`.
- `src/ui/`: DOM components, built with `h()` from `src/ui/dom.ts` (`icons.ts` uses `createElementNS`, since `h()` makes HTML elements only), including `background-view.ts` (the wallpaper layers). `reconcileChildren` in `dom.ts` replaces a list while keeping the elements that stay, so focus survives a re-render. `shortcuts.ts` binds the global keys and the skip link, and `panel-events.ts` the panel's click and drag delegation.
- `src/icons/`: the SVG sources of the extension icon (not shipped).
- `public/`: `manifest.json`, `private-rules.json` (the static declarativeNetRequest rules), `icons/` (the PNGs), `backgrounds/` (photos, thumbs and `CREDITS.txt`, the Unsplash notice that ships in the zip), `wallpapers/` (the user's own frames and manifest, git-ignored).
- `tests/unit/`: the Vitest tests, one per module at the same path as in `src/` (`src/ui/panel.ts` → `tests/unit/ui/panel.test.ts`), and `fixtures/`: `sample-library.ts`, `memory-storage.ts` (a storage area with `onChanged`, which, like Chromium, hands listeners a copy with its keys sorted) and `web-locks.ts` (happy-dom has no `navigator.locks`; it's a `setupFiles` entry). The config restores mocks, stubbed globals and env before each test, so tests don't clean those up by hand, and a stub made outside a test or hook never reaches a test: stub in `beforeEach` or the test itself.
- `tests/e2e/`: Playwright fixtures, a fake-site server, sample bookmarks, the specs and `preview.ts`. `appearance.spec.ts` measures contrast from screenshots (text, focus rings, the search results and the clock) on every bundled photo and on drawn uploads (white, pale, mid-grey, sky blue, a bright corner behind the clock), and checks forced-colors mode and the cross-fade; it runs in CI.
- `.github/`: CI and release workflows, the `package-extension` action, Dependabot, SECURITY.md and `screenshot.png` (the README image).

Generated files that are committed, with no generator in the repo:

- `src/wallpaper/timezone-coordinates.ts`: IANA `zone.tab` coordinates per zone, plus the tz database's aliases. Edit it by hand if a zone is missing.
- `public/icons/icon-{16,32,48,128}.png`: rendered once from `src/icons/icon.svg` (and `icon-16.svg` for the smallest size). Re-render all four after changing the SVG.

## Rules

- **Never insert HTML strings.** Use `h()`, `textContent` or `setAttribute`: bookmark titles are untrusted. The CSP enforces Trusted Types, so `innerHTML` would throw anyway.
- **Treat storage, IndexedDB, messages and fetched data as `unknown`** and validate them with type guards built on `src/validation.ts`. See `parseSettings`, `parseManifest`, `isIconRecord` and `isIconMessage`.
- **Network safety:** icons may only be fetched from the bookmarked site's own origin or from public hosts (`isPermittedIconUrl`, which `get()` applies to every request). Cross-origin icon and manifest fetches must not follow redirects, and for a public site they must be `https` (a public name can resolve to a LAN address, but a LAN device can't present a valid certificate for it). Same-origin ones may, and the declarativeNetRequest rules block every hop to a private address, except to bookmarked private hosts while their own icons are fetched (see Private-network blocking); for a public site the final URL must also pass `isPermittedIconUrl`. Keep size caps, timeouts, `credentials: "omit"` and `referrerPolicy: "no-referrer"`. README's privacy section summarises this, so keep it accurate.
- **No new runtime dependencies.** Dev dependencies are pinned to exact versions.
- **TypeScript runs strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Don't use `any`, `!` or `@ts-ignore`. Use ESM named exports.
- **Few comments**, and only for the non-obvious _why_.
- **Test data stays neutral** ("Acme", "Work", example.com). The repo is public.
- **Never commit `public/wallpapers/`**: the frames are usually Apple's artwork, and the folder is git-ignored.
- **Permissions:** if you change `public/manifest.json` permissions, update the permissions table in README.md.
- **Keyboard shortcuts:** README's "Using Overlook" names the main keys from `src/ui/shortcuts.ts`, `src/ui/spotlight.ts` and `src/ui/navigation.ts`. Keep it true when they change.
- **Wallpaper manifest:** README's "Dynamic wallpaper" section documents the format `parseManifest` accepts. Change them together.

## Gotchas

- **Keyboard focus on a new tab** (`src/focus-step.ts`): Chromium gives it to the address bar and the new-tab page can't take it back.
  - How: after `load`, the page steps forward to `newtab.html?focus` (a page the tab navigated to may take focus), then `history.back()`, which keeps the focus and empties the address bar. Navigating before `load` turns into a replace. The setting is mirrored to `localStorage` (the same key literal in `focus-step.ts` and `main.ts`) because the script can't wait for `chrome.storage`.
  - Why it works: `chrome/browser/ui/focus_tab_after_navigation_helper.cc` focuses the page on a page-initiated navigation away from the new-tab page; `chrome.tabs.update` is excluded on purpose (crbug.com/40693812).
  - Doesn't work: `focus()` alone, `document.hasFocus()` as a check, `pushState`, `location.reload()`, navigating or `chrome.tabs.update` to `chrome://newtab`. Only a real Cmd+T shows the effect.
- **The manifest `key` fixes the extension ID** (`imabhmapeefoacmhgemijamhnfcnbdoa`), whatever folder the unpacked extension is loaded from, so updates keep users' data, and `private-rules.json` names that ID. Only the public key is in the repo (secret scanners flag it as an API key; it isn't secret); there is no private key because nothing is packed as a .crx.
- **Private-network blocking** (`public/private-rules.json`, `src/favicons/private-origin-rules.ts`): static rules block the extension's own requests, redirect hops included, to private hosts before they're sent. Each rule has `initiatorDomains` set to the extension ID; without it they would block web pages' own LAN requests browser-wide. Each regex is its own rule, because a combined one exceeds the 2 KB compiled-regex limit. Keep them in step with `isPrivateNetworkHost`; `private-origin-rules.test.ts` checks them against tables of private and public hosts. `allowBookmarkedPrivateSites` adds one higher-priority dynamic allow rule per private host in the bookmarks (`requestDomains`, so any port or scheme on that host), and `blockPrivateSites` removes them all. DNR can't see which site a redirect came from, so a public site must never be fetched while those rules exist: `IconSync` fetches private and public sites in separate passes, allowing right before a private pass and blocking right after it, and every public pass blocks first (which also clears rules a worker stopped mid-pass left behind). If allowing fails, that private batch is skipped; if blocking fails, no public site is fetched. A blocked request fails like a network error, so an intranet site that redirects to a private host that isn't bookmarked usually ends up unreachable. One whose redirect is followed (to a bookmarked host, or to another port or scheme on its own host) keeps only its `/favicon.ico` and `/apple-touch-icon.png`: its page is read only on its own host (`isOnSite`), and page and manifest icons are accepted only from its own origin (`isPermittedIconUrl`). A bookmark of the address it lands on gets the full icon.
- **The dynamic wallpaper is detected by the service worker:** a missing extension file can't be fetched without a console error, so `service-worker.ts` checks for `wallpapers/manifest.json` on install and start-up and stores `wallpaperInstalled`; pages fetch the manifest only when it's `true`. When the flag changes, `watchDynamicWallpaper` drops the page's cached manifest and `app.ts` applies the background again; `app.ts` registers the watcher before its first `apply`, so a flag set while the page starts isn't missed. After adding frames, reload the extension.
- **`npm run preview` clears the profile's cached service worker:** Chromium otherwise keeps running an old copy of an unpacked extension's background script across launches.
- **TypeScript is pinned to 6.0.x:** typescript-eslint supports only TS < 6.1. `deps:update` (`--peer`) holds it back; Dependabot ignores TypeScript 6.1 and later. `@types/node` follows `engines`, so `deps:update` takes only its minor updates and Dependabot ignores its majors.
- **`minimatch` is overridden to 11.x** in `package.json`: ESLint 10 still asks for 10.x, which has a moderate advisory (GHSA-g3hv-75wg-m249) that would fail CI's `npm audit`. Remove the override once ESLint and typescript-eslint depend on 11.0.1 or later.
- **Font size:** Chromium's extension-page stylesheet shrinks body text to 75%, so type is set on `body`, not `:root`.
- **Wallpaper frames are chosen by the sun's altitude**, with azimuth only telling morning from evening (`src/wallpaper/schedule.ts`): schedules are shot at one latitude, and full sky position breaks elsewhere (Nordic summer sunrise is in the north-east). Location comes only from the time zone (`timezone-coordinates.ts`), never from geolocation.
- **Settings use `storage.local`:** `storage.sync` caps items at 8 KB, which labels exceed. A custom background carries `savedAt`, so replacing the image is a real settings change that every tab sees. The image is stored under `custom-background:<savedAt>` in the `files` store. `prepareCustomBackground` checks and shrinks an upload outside the lock; then, inside the settings lock, the upload saves the image under its own key, chooses it (unless another background was picked meanwhile) and, in `update`'s `afterSave`, prunes every other image if the settings now name it. Pruning never goes by age. A failed settings write leaves the old image in use. An image from before versioning (the single `custom-background` key) is moved once to the key the settings name.
- **Writes from several tabs:** `SettingsStore.update(change, afterSave?)` and `UsageStore.recordVisit` run inside a Web Lock (`overlook-settings`, `overlook-usage`) and re-read storage before they merge and write. `change` is a function (it may be async) of the freshly read settings, so another tab's change isn't lost; `afterSave` runs inside the same lock. Listeners run after the lock is released, and one that throws is logged without failing the write. `saveNow` is for `pagehide` only: a write merged onto the in-memory settings, with no lock and no read, because the page is gone before either would come back; the Labels section also writes a locked save that is still waiting this way. Both stores follow `storage.onChanged`; `SettingsStore` re-reads storage then and notifies only on a real change, and `UsageStore` notifies only about visits other tabs recorded (it compares the records with its own last write, not their JSON: Chromium reports values with their keys sorted).
- **Settings that couldn't be read:** if the page's first read fails, `current` holds the defaults and `loadFailed` is true. Opening Settings reads again before anything can be edited; if that fails too, Home and Labels are disabled with an error, and only Background (whose writes replace one value) stays editable.
- **Usage never re-sorts what's on screen:** a tab's own visits don't re-render Home, and other tabs' visits are applied on the next `visibilitychange` to visible, so the card under the pointer doesn't move. Playwright keeps every page visible, so e2e tests dispatch `visibilitychange` by hand.
- **Adaptive darkening** (`background-view.ts`): each shown image is decoded with `createImageBitmap`, off the main thread, to at least 128x80 (a second, height-bound decode for images wider than 16:10), so a cell stays near 20 CSS px up to a 2560x1600 window. Each surface (the top band behind the clock, search and Settings; the search results; the sidebar; the panel) maps its window area through the `object-fit: cover` crop (`FOCUS_X`/`FOCUS_Y` mirror `object-position: 50% 45%`), takes the 95th-percentile luminance under it and sets its own registered property (`--shade-top`, `--shade-results`, `--shade-sidebar`, `--shade-panel`). The top one darkens a band in `.wallpaper__scrim` (full to 260px, gone by 420px, so it must keep covering the clock, search and Settings in every layout); the others lower the glass's `backdrop-filter` brightness. The rest of the wallpaper isn't dimmed. `UNTINTED_LIMIT` was calibrated for 4.7:1 on uniform uploads: recalibrate it if glass fills, text colours or the scrim change. Tints are recomputed, without decoding again, on resize. An image that can't be measured still shows, with every tint at 0.5. Bundled photos and frames are fetched from the extension; uploads use their Blob, since a page can't fetch a `blob:` URL. A frame that fails to decode isn't tried again while the page is open.
- **The search popover is anchored** to the search field (CSS anchor positioning, `position-try-fallbacks: flip-block`), so in a window with no room below the field, such as a zoomed or very short one, the results open above it.
- **Cards use `content-visibility: auto`:** `contain-intrinsic-block-size` on `.link-card-wrap` is a card's real height. Change it with the card's padding, border, font sizes or line height, or re-renders shift the scroll position (`home.spec.ts` catches it).
- **Build warning:** Vite's `<script src="./focus-step.js"> ... can't be bundled without type="module"` is expected. `focus-step.js` is its own entry, loaded as a classic `<head>` script so it runs before the page renders.
- **Service-worker lifetime:** Chrome stops idle extension service workers after 30 s, and fetches don't count as activity. `service-worker.ts` pings an extension API while a sync runs.
- **e2e browser setup** (`tests/e2e/fixtures.ts`):
  - Tests take the extension ID from the service worker URL.
  - Chromium starts with `--host-resolver-rules=MAP public.example.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, so tests never reach the internet. `context.route` answers every other http(s) host with a stub page. `FakeSites` serves on 127.0.0.1 and on `public.example.com`, a host the extension treats as public (used by the redirect test).
  - Fixture options: `wallpaper` is `fixture` (default, 1×1 frames), `none` (no wallpaper, so the default photo) or `real` (your own frames from `public/wallpapers/`, copied into `dist/` by the build); `focusStep` (default `false`) turns the focus step off, because it races most tests; set it to `true` (as the focus tests in `newtab.spec.ts` do) to let it run; `wideFont` (default `false`) forces Verdana or DejaVu Sans, so layout breaks that only Linux's wider fonts cause show on macOS too (`responsive.spec.ts` runs its layout tests both ways).
  - `visual.spec.ts` and the window-width review in `responsive.spec.ts` (`@visual`) write review screenshots to `test-results/`. CI skips `@visual` and retries failures once.

## CI and releases

The workflows in `.github/workflows/` say what runs. Two things they can't:

- **Private vulnerability reporting** must be turned on in the repository settings (Settings → Code security) before the repo goes public, and stay on: SECURITY.md sends reporters to the Security tab's **Report a vulnerability** button, which only exists while it's enabled.
- The release workflow fails unless the tag matches `version` in both `package.json` and `public/manifest.json`.

To release:

1. Run `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`), then set the same `version` in `public/manifest.json`. Skip this for v0.1.0: both files already say 0.1.0.
2. Run `npm run check`.
3. Commit, push main, then push a tag `vX.Y.Z` (`git tag v0.2.0 && git push origin v0.2.0`).
