import { warn } from "../log";
import { coordinatesForTimeZone, currentTimeZone } from "./location";
import { frameFor, parseManifest, type WallpaperManifest } from "./schedule";
import { WALLPAPER_DIR, WALLPAPER_INSTALLED_KEY, WALLPAPER_MANIFEST_PATH } from "./wallpaper-flag";

let manifest: Promise<WallpaperManifest | null> | undefined;

async function isWallpaperInstalled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(WALLPAPER_INSTALLED_KEY);
  return stored[WALLPAPER_INSTALLED_KEY] === true;
}

// A page clears the flag when the folder has gone since, so only the first tab pays for the
// failing fetch.
async function fetchManifest(): Promise<Response> {
  try {
    const response = await fetch(WALLPAPER_MANIFEST_PATH);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error: unknown) {
    await chrome.storage.local.set({ [WALLPAPER_INSTALLED_KEY]: false });
    throw error;
  }
}

async function readManifest(): Promise<WallpaperManifest | null> {
  if (!(await isWallpaperInstalled())) return null;
  try {
    const response = await fetchManifest();
    return parseManifest(await response.json());
  } catch (error: unknown) {
    warn(`use the dynamic wallpaper in ${WALLPAPER_MANIFEST_PATH}`, error);
    return null;
  }
}

// The flag can change after a page has looked: the worker's check finishes late, or a page clears it.
export function watchDynamicWallpaper(onChange: () => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(WALLPAPER_INSTALLED_KEY in changes)) return;
    manifest = undefined;
    onChange();
  });
}

export function loadDynamicWallpaper(): Promise<WallpaperManifest | null> {
  if (manifest) return manifest;
  const loading = readManifest().catch((error: unknown) => {
    warn("check for a dynamic wallpaper", error);
    // Storage may be readable next time.
    if (manifest === loading) manifest = undefined;
    return null;
  });
  manifest = loading;
  return loading;
}

export function currentFrame(
  wallpaper: WallpaperManifest,
  now = new Date(),
): { frame: number; src: string } {
  const timeZone = currentTimeZone();
  const { frame, file } = frameFor(wallpaper, now, timeZone, coordinatesForTimeZone(timeZone, now));
  return { frame, src: `${WALLPAPER_DIR}${file}` };
}
