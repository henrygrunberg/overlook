import { deleteRecords, getAllKeys, getRecord, putRecord } from "../storage/database";

// Each upload gets its own key, named in the settings by its savedAt, so a settings write that
// fails leaves the image they name in place.
const KEY_PREFIX = "custom-background:";
// Where uploads were kept before they had their own keys.
const LEGACY_KEY = "custom-background";
export const MAX_CUSTOM_BACKGROUND_BYTES = 25 * 1024 * 1024;
// About the size of a dynamic wallpaper's frames; a camera original would be decoded in full in
// every new tab.
const MAX_EDGE_PIXELS = 3200;
const JPEG_QUALITY = 0.85;

const keyFor = (savedAt: number) => `${KEY_PREFIX}${savedAt}`;

async function uploadTimes(): Promise<number[]> {
  return (await getAllKeys("files"))
    .filter((key) => key.startsWith(KEY_PREFIX))
    .map((key) => Number(key.slice(KEY_PREFIX.length)));
}

// The settings still name the legacy image by its savedAt: it moves to that key, once.
async function moveLegacyImage(savedAt: number): Promise<unknown> {
  const legacy = await getRecord("files", LEGACY_KEY);
  // Another tab may have just moved it.
  if (legacy === undefined) return getRecord("files", keyFor(savedAt));
  await putRecord("files", legacy, keyFor(savedAt));
  await deleteRecords("files", [LEGACY_KEY]);
  return legacy;
}

export async function readCustomBackground(savedAt: number): Promise<Blob | null> {
  const stored = (await getRecord("files", keyFor(savedAt))) ?? (await moveLegacyImage(savedAt));
  return stored instanceof Blob ? stored : null;
}

/** The newest upload, whatever is chosen now. */
export async function latestCustomBackground(): Promise<{
  readonly savedAt: number;
  readonly image: Blob;
} | null> {
  const times = await uploadTimes();
  if (times.length === 0) return null;
  const savedAt = Math.max(...times);
  const image = await getRecord("files", keyFor(savedAt));
  return image instanceof Blob ? { savedAt, image } : null;
}

/** Call inside the settings lock, right after the settings were made to name `keepSavedAt`. */
export async function pruneCustomBackgrounds(keepSavedAt: number): Promise<void> {
  const others = (await uploadTimes()).filter((savedAt) => savedAt !== keepSavedAt);
  await deleteRecords("files", [LEGACY_KEY, ...others.map(keyFor)]);
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Also what a supported image too large to decode gets.
    throw new Error(
      "Couldn't open this image. Choose a JPEG, PNG, WebP or AVIF image under 25 MB.",
    );
  }
}

async function downscaled(file: Blob): Promise<Blob> {
  const bitmap = await decode(file);
  try {
    const scale = MAX_EDGE_PIXELS / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return file;
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale),
    );
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not resize the image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  } finally {
    bitmap.close();
  }
}

/** Checks and shrinks an upload; slow for a large photo, so it's done before saving. */
export async function prepareCustomBackground(file: Blob): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_CUSTOM_BACKGROUND_BYTES) throw new Error("Choose an image under 25 MB.");
  return downscaled(file);
}

export async function saveCustomBackground(image: Blob, savedAt: number): Promise<void> {
  await putRecord("files", image, keyFor(savedAt));
}
