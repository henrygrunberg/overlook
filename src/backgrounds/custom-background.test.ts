import { beforeEach, describe, expect, it, vi } from "vitest";
import { putRecord } from "../storage/database";
import { MAX_CUSTOM_BACKGROUND_BYTES, saveCustomBackground } from "./custom-background";

vi.mock("../storage/database", () => ({ getRecord: vi.fn(), putRecord: vi.fn() }));

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

describe("saveCustomBackground", () => {
  beforeEach(() => {
    vi.mocked(putRecord).mockClear();
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  });

  it("refuses an image the browser can't decode, and saves nothing", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new DOMException("unsupported", "InvalidStateError"))),
    );
    const heic = new Blob(["heic"], { type: "image/heic" });

    await expect(saveCustomBackground(heic)).rejects.toThrow("isn't supported");
    expect(putRecord).not.toHaveBeenCalled();
  });

  it("refuses an image over 25 MB without decoding it", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const huge = new Blob(["png"], { type: "image/png" });
    Object.defineProperty(huge, "size", { value: MAX_CUSTOM_BACKGROUND_BYTES + 1 });

    await expect(saveCustomBackground(huge)).rejects.toThrow("under 25 MB");
    expect(decode).not.toHaveBeenCalled();
    expect(putRecord).not.toHaveBeenCalled();
  });

  it("keeps an image that is small enough as it is", async () => {
    const close = decodesAs(2560, 1440);
    const photo = new Blob(["png"], { type: "image/png" });

    await saveCustomBackground(photo);
    expect(putRecord).toHaveBeenCalledWith("files", photo, "custom-background");
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

    await saveCustomBackground(new Blob(["jpeg"], { type: "image/jpeg" }));
    expect(canvases.map(({ width, height }) => [width, height])).toEqual([[3200, 2133]]);
    expect(canvases[0]?.convertToBlob).toHaveBeenCalledWith({ type: "image/jpeg", quality: 0.85 });
    expect(putRecord).toHaveBeenCalledWith("files", resized, "custom-background");
    expect(close).toHaveBeenCalled();
  });
});
