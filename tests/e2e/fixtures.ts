import {
  test as base,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { FakeSites, PUBLIC_LOOKING_HOST } from "./fake-sites.ts";
import { SAMPLE_BOOKMARKS, seedBookmarks } from "./sample-bookmarks.ts";

export { seedBookmarks, type SeedNode } from "./sample-bookmarks.ts";

const DIST = resolve(import.meta.dirname, "../../dist");
const FAKE_SITE_HOSTS = new Set(["127.0.0.1", PUBLIC_LOOKING_HOST]);

/** "real" uses your own frames from public/wallpapers; the others make tests deterministic. */
export type WallpaperSetup = "fixture" | "none" | "real";

// A 1×1 PNG: frame contents don't matter, only which frame is shown.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const FIXTURE_WALLPAPER = {
  version: 1,
  mode: "solar",
  frames: [...Array(8).keys()].map((index) => `frame-${index}.png`),
  schedule: [
    { frame: 0, altitude: 10, azimuth: 100 },
    { frame: 1, altitude: -25, azimuth: 70 },
    { frame: 2, altitude: -9, azimuth: 80 },
    { frame: 3, altitude: 0, azimuth: 90 },
    { frame: 4, altitude: 25, azimuth: 110 },
    { frame: 4, altitude: 25, azimuth: 250 },
    { frame: 5, altitude: 10, azimuth: 260 },
    { frame: 6, altitude: 0, azimuth: 270 },
    { frame: 7, altitude: -9, azimuth: 280 },
    { frame: 1, altitude: -25, azimuth: 290 },
  ],
};

function prepareExtension(setup: WallpaperSetup): string {
  if (!existsSync(join(DIST, "manifest.json"))) {
    throw new Error("Build the extension first: npm run build");
  }
  if (setup === "real") return realpathSync(DIST);

  const directory = realpathSync(mkdtempSync(join(tmpdir(), "overlook-extension-")));
  cpSync(DIST, directory, {
    recursive: true,
    filter: (source) => relative(DIST, source).split(sep)[0] !== "wallpapers",
  });
  if (setup === "fixture") {
    const wallpapers = join(directory, "wallpapers");
    mkdirSync(wallpapers);
    writeFileSync(join(wallpapers, "manifest.json"), JSON.stringify(FIXTURE_WALLPAPER));
    for (const frame of FIXTURE_WALLPAPER.frames) writeFileSync(join(wallpapers, frame), PIXEL);
  }
  return directory;
}

interface BrowserOptions {
  readonly timezoneId: string | undefined;
  readonly locale: string | undefined;
}

async function launchBrowser(
  extensionPath: string,
  profileDir: string,
  { timezoneId, locale }: BrowserOptions,
): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    ...(timezoneId === undefined ? {} : { timezoneId }),
    ...(locale === undefined ? {} : { locale }),
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      // No real DNS: the icon service worker must never reach the internet during tests.
      `--host-resolver-rules=MAP ${PUBLIC_LOOKING_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    ],
  });
  // Opening a bookmark, or fetching its icon, gets a stub page instead of the real site.
  await context.route(
    (url) => /^https?:$/.test(url.protocol) && !FAKE_SITE_HOSTS.has(url.hostname),
    (route) => route.fulfill({ contentType: "text/html", body: "<title>Visited</title>" }),
  );
  return context;
}

async function extensionServiceWorker(context: BrowserContext): Promise<Worker> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Pages show a dynamic wallpaper only once the worker has recorded that one is installed.
  await expect
    .poll(() =>
      worker.evaluate(
        async () => "wallpaperInstalled" in (await chrome.storage.local.get("wallpaperInstalled")),
      ),
    )
    .toBe(true);
  return worker;
}

async function turnOffFocusStep(context: BrowserContext, serviceWorker: Worker, newTabUrl: string) {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { focusSearchOnOpen: false } }),
  );
  // The first page still steps, then mirrors the setting into localStorage for every later page.
  const page = await context.newPage();
  await page.goto(newTabUrl);
  await page.getByRole("button", { name: "Settings" }).waitFor();
  await page.close();
}

interface Fixtures {
  wallpaper: WallpaperSetup;
  /** The step navigates the page as it opens, which would race most tests, so it starts off. */
  focusStep: boolean;
  focusStepSetup: undefined;
  extensionPath: string;
  profileDir: string;
  context: BrowserContext;
  /** Reruns the start-up sync: chrome.runtime.reload() unloads a command-line extension for good. */
  restartBrowser: () => Promise<BrowserContext>;
  serviceWorker: Worker;
  extensionId: string;
  newTabUrl: string;
  newTab: Page;
  fakeSites: FakeSites;
}

export const test = base.extend<Fixtures>({
  wallpaper: ["fixture", { option: true }],
  focusStep: [false, { option: true }],

  extensionPath: async ({ wallpaper }, use) => {
    const path = prepareExtension(wallpaper);
    await use(path);
    if (wallpaper !== "real") rmSync(path, { recursive: true, force: true });
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first argument.
  profileDir: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), "overlook-profile-"));
    await use(directory);
    rmSync(directory, { recursive: true, force: true });
  },

  context: async ({ extensionPath, profileDir, timezoneId, locale }, use) => {
    const context = await launchBrowser(extensionPath, profileDir, { timezoneId, locale });
    await use(context);
    await context.close();
  },

  restartBrowser: async ({ context, extensionPath, profileDir, timezoneId, locale }, use) => {
    let current = context;
    await use(async () => {
      await current.close();
      current = await launchBrowser(extensionPath, profileDir, { timezoneId, locale });
      await extensionServiceWorker(current);
      return current;
    });
    await current.close();
  },

  serviceWorker: async ({ context }, use) => {
    await use(await extensionServiceWorker(context));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first argument.
  fakeSites: async ({}, use) => {
    const sites = new FakeSites();
    await use(sites);
    await sites.close();
  },

  newTabUrl: async ({ extensionId }, use) => {
    await use(`chrome-extension://${extensionId}/newtab.html`);
  },

  focusStepSetup: [
    async ({ focusStep, context, serviceWorker, newTabUrl }, use) => {
      if (!focusStep) await turnOffFocusStep(context, serviceWorker, newTabUrl);
      await use(undefined);
    },
    { auto: true },
  ],

  newTab: async ({ context, serviceWorker, newTabUrl }, use) => {
    await seedBookmarks(serviceWorker, SAMPLE_BOOKMARKS);
    const page = await context.newPage();
    await page.goto(newTabUrl);
    await page.getByRole("button", { name: /Work/ }).waitFor();
    await use(page);
  },
});

export const expect = test.expect;

export async function pin(page: Page, folder: RegExp, title: string): Promise<void> {
  await page.getByRole("button", { name: folder }).click();
  await page
    .getByRole("main")
    .getByRole("link", { name: new RegExp(title) })
    .hover();
  await page.getByRole("button", { name: `Pin ${title} to Home` }).click();
  await expect(page.getByRole("button", { name: `Unpin ${title} from Home` })).toBeVisible();
}
