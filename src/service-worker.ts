import { buildLibrary } from "./bookmarks/library";
import { isIconMessage } from "./favicons/icon-messages";
import { IconSync } from "./favicons/icon-sync";
import { warnOnFailure } from "./log";
import { WALLPAPER_INSTALLED_KEY, WALLPAPER_MANIFEST_PATH } from "./wallpaper/wallpaper-flag";

const icons = new IconSync();
// Chrome stops idle service workers after 30 s and fetches don't count; extension API calls do.
const KEEP_ALIVE_MS = 20_000;
// A first Sync creates bookmarks in bursts; they're synced together once it settles.
const BOOKMARK_QUIET_MS = 1000;

let runningWork = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function run(work: () => Promise<void>): void {
  if (runningWork++ === 0) {
    keepAliveTimer = setInterval(() => {
      void chrome.runtime.getPlatformInfo();
    }, KEEP_ALIVE_MS);
  }
  work()
    .catch(warnOnFailure("sync bookmark icons"))
    .finally(() => {
      if (--runningWork === 0) clearInterval(keepAliveTimer);
    });
}

async function readBookmarkUrls(): Promise<string[]> {
  const library = buildLibrary(await chrome.bookmarks.getTree());
  return library.bookmarks.map((bookmark) => bookmark.url);
}

function syncAllBookmarks(): void {
  run(async () => {
    await icons.ensure(await readBookmarkUrls());
    // Bookmarks can change during a sync that takes minutes.
    await icons.pruneExcept(await readBookmarkUrls());
  });
}

function syncIcons(urls: readonly string[], force = false): void {
  run(() => icons.ensure(urls, force));
}

let importing = false;
const changedUrls = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function syncSoon(url: string): void {
  if (importing) return;
  changedUrls.add(url);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const urls = [...changedUrls];
    changedUrls.clear();
    syncIcons(urls);
  }, BOOKMARK_QUIET_MS);
}

let pruneTimer: ReturnType<typeof setTimeout> | undefined;

function pruneSoon(): void {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(() => {
    run(async () => icons.pruneExcept(await readBookmarkUrls()));
  }, BOOKMARK_QUIET_MS);
}

// Pages fetch the wallpaper manifest only when this says it exists: a missing extension file
// can't be fetched quietly, and every new tab would log a network error.
async function checkForWallpaper(): Promise<void> {
  const installed = await fetch(WALLPAPER_MANIFEST_PATH).then(
    (response) => response.ok,
    () => false,
  );
  await chrome.storage.local.set({ [WALLPAPER_INSTALLED_KEY]: installed });
}

function onInstallOrStartup(): void {
  syncAllBookmarks();
  checkForWallpaper().catch(warnOnFailure("check for a dynamic wallpaper"));
}

chrome.runtime.onInstalled.addListener(onInstallOrStartup);
chrome.runtime.onStartup.addListener(onInstallOrStartup);

chrome.bookmarks.onImportBegan.addListener(() => {
  importing = true;
});
chrome.bookmarks.onImportEnded.addListener(() => {
  importing = false;
  syncAllBookmarks();
});
chrome.bookmarks.onCreated.addListener((_id, bookmark) => {
  if (bookmark.url) syncSoon(bookmark.url);
});
chrome.bookmarks.onChanged.addListener((_id, change) => {
  if (!change.url) return;
  syncSoon(change.url);
  pruneSoon();
});
chrome.bookmarks.onRemoved.addListener(pruneSoon);

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || !isIconMessage(message)) return;
  syncIcons(message.urls, message.type === "refresh-icons");
});
