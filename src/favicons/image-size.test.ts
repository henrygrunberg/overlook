import { describe, expect, it } from "vitest";
import { imageSize } from "./image-size";

type Part = readonly number[] | Uint8Array | string;

const ascii = new TextEncoder();

function bytes(...parts: readonly Part[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    parts.flatMap((part) => (typeof part === "string" ? [...ascii.encode(part)] : [...part])),
  );
}

const uint16le = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const uint16be = (value: number) => uint16le(value).reverse();
const uint24le = (value: number) => [...uint16le(value), (value >>> 16) & 0xff];
const uint32le = (value: number) => [...uint16le(value), ...uint16le(value >>> 16)];
const uint32be = (value: number) => uint32le(value).reverse();

const png = (width: number, height: number) =>
  bytes(
    [0x89],
    "PNG\r\n",
    [0x1a, 0x0a],
    uint32be(13),
    "IHDR",
    uint32be(width),
    uint32be(height),
    [8, 6, 0, 0, 0],
  );

const jpeg = (width: number, height: number, beforeFrame: Part = []) =>
  bytes(
    [0xff, 0xd8, 0xff, 0xe0],
    uint16be(16),
    "JFIF\0",
    Array<number>(9).fill(0),
    beforeFrame,
    [0xff, 0xc2],
    uint16be(17),
    [8],
    uint16be(height),
    uint16be(width),
    Array<number>(10).fill(0),
  );

const webp = (chunk: string, payload: Part) =>
  bytes("RIFF", uint32le(40), "WEBP", chunk, uint32le(20), payload, Array<number>(12).fill(0));

const bmp = (header: Part) => bytes("BM", uint32le(0), uint32le(0), uint32le(54), header);
const dib = (width: number, height: number) =>
  bytes(uint32le(40), uint32le(width), uint32le(height), Array<number>(28).fill(0));

function ico(images: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let offset = 6 + images.length * 16;
  const entries = images.map((image) => {
    const entry = [16, 16, 0, 0, ...uint16le(1), ...uint16le(32), ...uint32le(image.length)];
    entry.push(...uint32le(offset));
    offset += image.length;
    return entry;
  });
  return bytes([0, 0, 1, 0], uint16le(images.length), ...entries, ...images);
}

describe("imageSize", () => {
  it.each([
    ["a PNG", png(20000, 300), { width: 20000, height: 300 }],
    [
      "a GIF",
      bytes("GIF89a", uint16le(640), uint16le(480), [0, 0, 0]),
      { width: 640, height: 480 },
    ],
    ["a JPEG", jpeg(4000, 3000), { width: 4000, height: 3000 }],
    ["a JPEG with padding before its frame", jpeg(64, 48, [0xff, 0xff]), { width: 64, height: 48 }],
    [
      "a JPEG with a Huffman table before its frame",
      jpeg(64, 48, [0xff, 0xc4, ...uint16be(4), 0, 0]),
      { width: 64, height: 48 },
    ],
    [
      "a lossy WebP",
      webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...uint16le(200), ...uint16le(100)]),
      { width: 200, height: 100 },
    ],
    [
      "a lossless WebP",
      webp("VP8L", [0x2f, ...uint32le((500 - 1) | ((300 - 1) << 14))]),
      { width: 500, height: 300 },
    ],
    [
      "an extended WebP",
      webp("VP8X", [0, 0, 0, 0, ...uint24le(16000 - 1), ...uint24le(9 - 1)]),
      { width: 16000, height: 9 },
    ],
    ["a top-down BMP", bmp(dib(40, -30)), { width: 40, height: 30 }],
    [
      "an OS/2 BMP",
      bmp([...uint32le(12), ...uint16le(33), ...uint16le(44), 0, 0, 0, 0]),
      { width: 33, height: 44 },
    ],
    ["a cursor", bytes([0, 0, 2, 0], ico([png(48, 48)]).subarray(4)), { width: 48, height: 48 }],
  ])("reads the size of %s", (_format, file, size) => {
    expect(imageSize(file)).toEqual(size);
  });

  it("takes an icon file's largest image, not counting a bitmap's transparency mask", () => {
    expect(imageSize(ico([png(48, 48), dib(256, 512)]))).toEqual({ width: 256, height: 256 });
  });

  it("goes by an icon's own header when its directory entry understates it", () => {
    expect(imageSize(ico([png(5000, 5000)]))).toEqual({ width: 5000, height: 5000 });
  });

  it.each([
    ["an AVIF image", bytes(uint32be(28), "ftypavif", Array<number>(20).fill(0))],
    ["an SVG image", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["an empty file", bytes()],
    ["a cut-off PNG", png(64, 64).subarray(0, 20)],
    ["a cut-off GIF", bytes("GIF89a", [1])],
    ["a JPEG without a frame header", bytes([0xff, 0xd8, 0xff, 0xda], Array<number>(12).fill(0))],
    [
      "a JPEG with a broken segment length",
      bytes([0xff, 0xd8, 0xff, 0xe0, 0, 1], Array<number>(12).fill(0)),
    ],
    ["a WebP of an unknown kind", webp("VP8Z", Array<number>(10).fill(0))],
    ["a cut-off WebP", bytes("RIFF", uint32le(4), "WEBP")],
    ["an icon file without images", bytes([0, 0, 1, 0], uint16le(0))],
    ["an icon file whose image lies past its end", ico([png(16, 16)]).subarray(0, 30)],
  ])("doesn't size %s", (_label, file) => {
    expect(imageSize(file)).toBeNull();
  });
});
