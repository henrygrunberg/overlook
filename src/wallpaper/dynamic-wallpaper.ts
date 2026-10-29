import { warn } from "../log";
import { coordinatesForTimeZone, currentTimeZone } from "./location";
import { frameFor, parseManifest, type WallpaperManifest } from "./schedule";

const WALLPAPER_DIR = "wallpapers/";
// Set by service-worker.ts, which checks at startup whether a wallpaper is installed. A page clears it
// when the folder has gone since, so only the first tab pays for the failing fetch.
const INSTALLED_FLAG = "wallpaperInstalled";

let manifest: Promise<WallpaperManifest | null> | undefined;

async function isWallpaperInstalled(): Promise<boolean> {
  const stored: unknown = (await chrome.storage.local.get(INSTALLED_FLAG))[INSTALLED_FLAG];
  return stored === true;
}

async function fetchManifest(): Promise<Response> {
  try {
    const response = await fetch(`${WALLPAPER_DIR}manifest.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error: unknown) {
    await chrome.storage.local.set({ [INSTALLED_FLAG]: false });
    throw error;
  }
}

async function readManifest(): Promise<WallpaperManifest | null> {
  try {
    if (!(await isWallpaperInstalled())) return null;
    const response = await fetchManifest();
    return parseManifest(await response.json());
  } catch (error: unknown) {
    warn(`use the dynamic wallpaper in ${WALLPAPER_DIR}manifest.json`, error);
    return null;
  }
}

export function loadDynamicWallpaper(): Promise<WallpaperManifest | null> {
  manifest ??= readManifest();
  return manifest;
}

export function currentFrame(
  wallpaper: WallpaperManifest,
  now = new Date(),
): { frame: number; src: string } {
  const timeZone = currentTimeZone();
  const { frame, file } = frameFor(wallpaper, now, timeZone, coordinatesForTimeZone(timeZone, now));
  return { frame, src: `${WALLPAPER_DIR}${file}` };
}
