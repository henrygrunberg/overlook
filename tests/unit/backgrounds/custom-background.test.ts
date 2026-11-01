import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteRecords, getAllKeys, getRecord, putRecord } from "../../../src/storage/database";
import {
  MAX_CUSTOM_BACKGROUND_BYTES,
  latestCustomBackground,
  prepareCustomBackground,
  pruneCustomBackgrounds,
  readCustomBackground,
  saveCustomBackground,
} from "../../../src/backgrounds/custom-background";

vi.mock("../../../src/storage/database", () => ({
  getRecord: vi.fn(),
  putRecord: vi.fn(),
  getAllKeys: vi.fn(),
  deleteRecords: vi.fn(),
}));

function storedFiles(files: Record<string, unknown>) {
  vi.mocked(getRecord).mockImplementation((_store, key) => Promise.resolve(files[key]));
  vi.mocked(getAllKeys).mockImplementation(() => Promise.resolve(Object.keys(files)));
  vi.mocked(putRecord).mockImplementation((_store, value, key) => {
    files[String(key)] = value;
    return Promise.resolve();
  });
  vi.mocked(deleteRecords).mockImplementation((_store, keys) => {
    for (const key of keys) Reflect.deleteProperty(files, key);
    return Promise.resolve();
  });
  return files;
}

const resized = new Blob(["resized"], { type: "image/jpeg" });

class FakeCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext() {
    return { drawImage: vi.fn(), imageSmoothingQuality: "low" };
  }
  convertToBlob = vi.fn(() => Promise.resolve(resized));
}

function decodesAs(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(() => Promise.resolve({ width, height, close })),
  );
  return close;
}

describe("prepareCustomBackground", () => {
  beforeEach(() => {
    vi.mocked(putRecord).mockClear();
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  });

  it("refuses an image the browser can't decode", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new DOMException("unsupported", "InvalidStateError"))),
    );
    const heic = new Blob(["heic"], { type: "image/heic" });

    await expect(prepareCustomBackground(heic)).rejects.toThrow(
      "Couldn't open this image. Choose a JPEG, PNG, WebP or AVIF image under 25 MB.",
    );
  });

  it("refuses an image over 25 MB without decoding it", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const huge = new Blob(["png"], { type: "image/png" });
    Object.defineProperty(huge, "size", { value: MAX_CUSTOM_BACKGROUND_BYTES + 1 });

    await expect(prepareCustomBackground(huge)).rejects.toThrow("under 25 MB");
    expect(decode).not.toHaveBeenCalled();
  });

  it("keeps an image that is small enough as it is", async () => {
    const close = decodesAs(2560, 1440);
    const photo = new Blob(["png"], { type: "image/png" });

    expect(await prepareCustomBackground(photo)).toBe(photo);
    expect(close).toHaveBeenCalled();
  });

  it("scales a large image down to 3200 px on its long edge as a JPEG", async () => {
    const close = decodesAs(6000, 4000);
    const canvases: FakeCanvas[] = [];
    vi.stubGlobal(
      "OffscreenCanvas",
      class extends FakeCanvas {
        constructor(width: number, height: number) {
          super(width, height);
          canvases.push(this);
        }
      },
    );

    expect(await prepareCustomBackground(new Blob(["jpeg"], { type: "image/jpeg" }))).toBe(resized);
    expect(canvases.map(({ width, height }) => [width, height])).toEqual([[3200, 2133]]);
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: "image/jpeg", quality: 0.85 });
    expect(close).toHaveBeenCalled();
  });
});

describe("saveCustomBackground", () => {
  it("saves each upload under its own key", async () => {
    const files = storedFiles({});
    await saveCustomBackground(resized, 1700);
    expect(files).toEqual({ "custom-background:1700": resized });
  });
});

describe("stored custom backgrounds", () => {
  const older = new Blob(["older"]);
  const newer = new Blob(["newer"]);
  const legacy = new Blob(["legacy"]);

  it("reads the image saved at the given time, keeping the others", async () => {
    storedFiles({ "custom-background:1": older, "custom-background:2": newer });
    expect(await readCustomBackground(1)).toBe(older);
    expect(await readCustomBackground(2)).toBe(newer);
  });

  it("moves an image saved before images were versioned to the key the settings name", async () => {
    const files = storedFiles({ "custom-background": legacy });
    expect(await readCustomBackground(1234)).toBe(legacy);
    expect(files).toEqual({ "custom-background:1234": legacy });
    expect(await latestCustomBackground()).toEqual({ savedAt: 1234, image: legacy });
  });

  it("finds the old image that another tab moved while this one looked for it", async () => {
    const files = storedFiles({});
    vi.mocked(getRecord).mockImplementation((_store, key) => {
      if (key === "custom-background") files["custom-background:7"] = legacy;
      return Promise.resolve(files[key]);
    });
    expect(await readCustomBackground(7)).toBe(legacy);
  });

  it("doesn't show the old image for an upload whose own is missing once it has moved", async () => {
    storedFiles({ "custom-background": legacy });
    await readCustomBackground(1);
    expect(await readCustomBackground(2)).toBeNull();
  });

  it("prefers a versioned upload over one saved before versioning", async () => {
    storedFiles({ "custom-background": legacy, "custom-background:5": newer });
    expect(await readCustomBackground(5)).toBe(newer);
    expect(await latestCustomBackground()).toEqual({ savedAt: 5, image: newer });
  });

  it("says when there is no image", async () => {
    storedFiles({ "custom-background:1": "not a blob" });
    expect(await readCustomBackground(1)).toBeNull();
    storedFiles({});
    expect(await latestCustomBackground()).toBeNull();
  });

  it("finds the newest upload", async () => {
    storedFiles({ "custom-background:1": older, "custom-background:2": newer, other: legacy });
    expect(await latestCustomBackground()).toEqual({ savedAt: 2, image: newer });
  });

  it("keeps only the image it is told to keep, whatever the others' age", async () => {
    const files = storedFiles({
      "custom-background": legacy,
      "custom-background:1": older,
      "custom-background:2": newer,
      "custom-background:3": newer,
      other: legacy,
    });
    await pruneCustomBackgrounds(2);
    expect(files).toEqual({ "custom-background:2": newer, other: legacy });
  });
});
