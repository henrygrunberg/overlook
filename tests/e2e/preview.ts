// Opens a separate Chromium window with the built extension and sample bookmarks, to try
// Overlook without installing it. The profile is kept between runs; delete it to start over.

import { chromium, type Page } from "@playwright/test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SAMPLE_BOOKMARKS, seedBookmarks } from "./sample-bookmarks.ts";

const extension = resolve(import.meta.dirname, "../../dist");
const profile = join(tmpdir(), "overlook-preview-profile");

if (!existsSync(join(extension, "manifest.json"))) {
  throw new Error("Build the extension first: npm run build");
}

// Chromium keeps running a cached copy of an unpacked extension's service worker across launches
// until the extension is reloaded, so drop it to pick up the fresh build.
rmSync(join(profile, "Default", "Service Worker"), { recursive: true, force: true });

const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--start-maximized",
  ],
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const newTabUrl = `chrome-extension://${new URL(worker.url()).host}/newtab.html`;

// Seeded through the service worker: the page may navigate itself while it takes focus.
const bookmarkCount = await worker.evaluate(async () => (await chrome.bookmarks.search({})).length);
if (bookmarkCount === 0) await seedBookmarks(worker, SAMPLE_BOOKMARKS);

// On macOS Chromium keeps running after its last window closes, so the context would never close.
const quitWithLastPage = (opened: Page) =>
  opened.on("close", () => {
    if (context.pages().length === 0) void context.close();
  });
context.pages().forEach(quitWithLastPage);
context.on("page", quitWithLastPage);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(newTabUrl);

console.log(`Overlook is open. Profile: ${profile}\nClose the browser window to quit.`);
await new Promise((resolve) => context.on("close", resolve));
