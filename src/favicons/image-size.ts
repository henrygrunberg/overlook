export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function fourCharacterCode(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function pngSize(view: DataView, offset: number): ImageSize | null {
  if (view.byteLength < offset + 24) return null;
  return { width: view.getUint32(offset + 16), height: view.getUint32(offset + 20) };
}

// Chromium widens the canvas to fit the first frame, wherever the logical screen ends.
function gifSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (view.byteLength < 13) return null;
  const flags = view.getUint8(10);
  let offset = 13 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  while (bytes[offset] === 0x21) {
    offset += 2;
    while ((bytes[offset] ?? 0) > 0) offset += (bytes[offset] ?? 0) + 1;
    offset++;
  }
  if (bytes[offset] !== 0x2c || view.byteLength < offset + 9) return null;
  const frame = (field: number) => view.getUint16(offset + field, true);
  return {
    width: Math.max(view.getUint16(6, true), frame(1) + frame(5)),
    height: Math.max(view.getUint16(8, true), frame(3) + frame(7)),
  };
}

// The header of a bitmap, after a BMP file's 14-byte file header or on its own inside an ICO.
function dibSize(view: DataView, offset: number): ImageSize | null {
  if (view.byteLength < offset + 12) return null;
  if (view.getUint32(offset, true) === 12) {
    return { width: view.getUint16(offset + 4, true), height: view.getUint16(offset + 6, true) };
  }
  return {
    width: Math.abs(view.getInt32(offset + 4, true)),
    height: Math.abs(view.getInt32(offset + 8, true)),
  };
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (view.byteLength < 30) return null;
  switch (fourCharacterCode(bytes, 12)) {
    case "VP8 ":
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    case "VP8L": {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X": {
      const uint24 = (offset: number) =>
        view.getUint16(offset, true) + view.getUint8(offset + 2) * 65536;
      return { width: uint24(24) + 1, height: uint24(27) + 1 };
    }
    default:
      return null;
  }
}

// C4, C8 and CC sit among the start-of-frame markers but begin other segments.
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  let offset = 2;
  while (offset + 9 <= view.byteLength && bytes[offset] === 0xff) {
    const marker = view.getUint8(offset + 1);
    if (isStartOfFrame(marker)) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // libjpeg reads these without a length: reading one here would land on a different frame.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

// Each image's own header counts, not its directory entry, whose size fields are a single byte.
function icoSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  const count = view.byteLength < 6 ? 0 : view.getUint16(4, true);
  if (count === 0 || view.byteLength < 6 + count * 16) return null;
  let width = 0;
  let height = 0;
  for (let entry = 6; entry < 6 + count * 16; entry += 16) {
    const offset = view.getUint32(entry + 12, true);
    const isPng = hasBytes(bytes, offset, PNG_SIGNATURE);
    const image = isPng ? pngSize(view, offset) : dibSize(view, offset);
    if (!image) return null;
    width = Math.max(width, image.width);
    // A bitmap entry's height also counts its transparency mask.
    height = Math.max(height, isPng ? image.height : image.height / 2);
  }
  return { width, height };
}

/** The size an image file declares in its header, or null if its format isn't recognised. */
export function imageSize(bytes: Uint8Array<ArrayBuffer>): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (hasBytes(bytes, 0, PNG_SIGNATURE)) return pngSize(view, 0);
  if (hasBytes(bytes, 0, [0xff, 0xd8])) return jpegSize(bytes, view);
  if (hasBytes(bytes, 0, [0, 0, 1, 0]) || hasBytes(bytes, 0, [0, 0, 2, 0])) {
    return icoSize(bytes, view);
  }
  const signature = fourCharacterCode(bytes, 0);
  if (signature === "GIF8") return gifSize(bytes, view);
  if (signature === "RIFF" && fourCharacterCode(bytes, 8) === "WEBP") return webpSize(bytes, view);
  if (signature.startsWith("BM")) return dibSize(view, 14);
  return null;
}
