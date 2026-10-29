import { getRecord, putRecord } from "../storage/database";

const KEY = "custom-background";
export const MAX_CUSTOM_BACKGROUND_BYTES = 25 * 1024 * 1024;
// About the size of a dynamic wallpaper's frames; a camera original would be decoded in full in
// every new tab.
const MAX_EDGE_PIXELS = 3200;
const JPEG_QUALITY = 0.85;

export async function readCustomBackground(): Promise<Blob | null> {
  const stored = await getRecord("files", KEY);
  return stored instanceof Blob ? stored : null;
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error("This image format isn't supported. Choose a JPEG, PNG, WebP or AVIF image.");
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

export async function saveCustomBackground(file: Blob): Promise<void> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_CUSTOM_BACKGROUND_BYTES) throw new Error("Choose an image under 25 MB.");
  await putRecord("files", await downscaled(file), KEY);
}
