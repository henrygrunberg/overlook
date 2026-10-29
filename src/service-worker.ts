import { buildLibrary } from "./bookmarks/library";
import { isIconMessage } from "./favicons/icon-messages";
import { IconSync } from "./favicons/icon-sync";
import { warnOnFailure } from "./log";

const icons = new IconSync();
// Chrome stops idle service workers after 30 s and fetches don't count; extension API calls do.
const KEEP_ALIVE_MS = 20_000;
// An import or a first Sync creates bookmarks in bursts; they're synced together once it settles.
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

async function allBookmarkUrls(): Promise<string[]> {
  return buildLibrary(await chrome.bookmarks.getTree()).bookmarks.map((bookmark) => bookmark.url);
}

function syncAllBookmarks(): void {
  run(async () => {
    await icons.ensure(await allBookmarkUrls());
    // Bookmarks can change during a sync that takes minutes. An empty read deletes nothing:
    // losing every icon to one bad read costs more than keeping a few stale ones.
    const current = await allBookmarkUrls();
    if (current.length > 0) await icons.pruneExcept(current);
  });
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
    run(() => icons.ensure(urls));
  }, BOOKMARK_QUIET_MS);
}

// Pages fetch the wallpaper manifest only when this says it exists: a missing extension file
// can't be fetched quietly, and every new tab would log a network error.
async function checkForWallpaper(): Promise<void> {
  const wallpaperInstalled = await fetch("wallpapers/manifest.json").then(
    (response) => response.ok,
    () => false,
  );
  await chrome.storage.local.set({ wallpaperInstalled });
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
  if (change.url) syncSoon(change.url);
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || !isIconMessage(message)) return;
  run(() => icons.ensure(message.urls, message.type === "refresh-icons"));
});
