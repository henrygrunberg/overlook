import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundView, tintOver } from "../../../src/ui/background-view";
import type { WallpaperManifest } from "../../../src/wallpaper/schedule";
import { readCustomBackground } from "../../../src/backgrounds/custom-background";
import { currentFrame, loadDynamicWallpaper } from "../../../src/wallpaper/dynamic-wallpaper";

vi.mock("../../../src/backgrounds/custom-background", () => ({ readCustomBackground: vi.fn() }));
vi.mock("../../../src/wallpaper/dynamic-wallpaper", () => ({
  loadDynamicWallpaper: vi.fn(),
  currentFrame: vi.fn(),
}));

const BROKEN_UPLOAD = "blob:broken";
const BROKEN_FRAME = "wallpapers/missing.jpg";
const UPLOAD = "blob:upload";
const WALLPAPER: WallpaperManifest = {
  mode: "time",
  schedule: [{ frame: 0, file: "frame.jpg", dayFraction: 0 }],
};

type Rgb = readonly [number, number, number];
const DARK: Rgb = [20, 24, 30];
const WHITE: Rgb = [255, 255, 255];
const PAGE_IDS = ["clock", "spotlight-slot", "sidebar", "panel"] as const;

const tint = (surface: string) =>
  Number(document.documentElement.style.getPropertyValue(`--shade-${surface}`));
const tints = () => ({
  top: tint("top"),
  results: tint("results"),
  sidebar: tint("sidebar"),
  panel: tint("panel"),
});

function place(id: string, x: number, y: number, width: number, height: number) {
  const element = document.createElement("div");
  element.id = id;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(x, y, width, height));
  document.body.append(element);
}

function resizeWindow(width: number, height: number) {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
}

describe("BackgroundView", () => {
  let root: HTMLElement;
  const revoked: string[] = [];
  let image: { width: number; height: number; colorAt: (x: number, y: number) => Rgb } = {
    width: 64,
    height: 40,
    colorAt: () => DARK,
  };
  const measured: Blob[] = [];
  const decodeSizes: ImageBitmapOptions[] = [];

  beforeEach(() => {
    root = document.createElement("div");
    revoked.length = 0;
    measured.length = 0;
    decodeSizes.length = 0;
    image = { width: 64, height: 40, colorAt: () => DARK };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(loadDynamicWallpaper).mockResolvedValue(null);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => revoked.push(url));
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
      this: HTMLImageElement,
    ) {
      return this.src === BROKEN_UPLOAD || this.src.endsWith(BROKEN_FRAME)
        ? Promise.reject(new DOMException("undecodable", "EncodingError"))
        : Promise.resolve();
    });
    resizeWindow(1440, 900);
    place("clock", 150, 84, 210, 72);
    place("spotlight-slot", 400, 84, 640, 58);
    place("sidebar", 124, 259, 256, 600);
    place("panel", 400, 259, 916, 600);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("avif")));
    vi.stubGlobal("createImageBitmap", (file: Blob, options: ImageBitmapOptions) => {
      measured.push(file);
      const { resizeQuality, ...size } = options;
      expect(resizeQuality).toBe("high");
      decodeSizes.push(size);
      const { resizeWidth, resizeHeight } = size;
      const scale = resizeWidth ? resizeWidth / image.width : (resizeHeight ?? 0) / image.height;
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      return Promise.resolve({ width, height, close: () => undefined });
    });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            drawImage: () => undefined,
            getImageData: (_x: number, _y: number, width: number, height: number) => ({
              data: Uint8ClampedArray.from(
                Array.from({ length: width * height }, (_, cell) => [
                  ...image.colorAt(
                    Math.floor(((cell % width) * image.width) / width),
                    Math.floor((Math.floor(cell / width) * image.height) / height),
                  ),
                  255,
                ]).flat(),
              ),
            }),
          };
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const id of PAGE_IDS) document.getElementById(id)?.remove();
    document.documentElement.removeAttribute("style");
  });

  it("shows the default photo when the uploaded image can't be decoded", async () => {
    vi.mocked(readCustomBackground).mockResolvedValue(new Blob(["heic"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue(BROKEN_UPLOAD);

    await new BackgroundView(root).apply({ kind: "custom", savedAt: 1 });
    expect(root.dataset.background).toBe("photo:autumn-forest");
    expect(root.dataset.state).toBe("ready");
    expect(revoked).toEqual([BROKEN_UPLOAD]);
  });

  it("frees the uploaded image once another background is shown", async () => {
    vi.mocked(readCustomBackground).mockResolvedValue(new Blob(["jpeg"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue(UPLOAD);
    const view = new BackgroundView(root);

    await view.apply({ kind: "custom", savedAt: 1 });
    expect(root.dataset.background).toBe("custom");
    expect(revoked).toEqual([]);

    await view.apply({ kind: "photo", photo: "still-lake" });
    expect(root.dataset.background).toBe("photo:still-lake");
    expect(revoked).toEqual([UPLOAD]);
  });

  it("keeps showing the default photo when the dynamic wallpaper frame can't be decoded", async () => {
    vi.useFakeTimers();
    vi.mocked(loadDynamicWallpaper).mockResolvedValue(WALLPAPER);
    vi.mocked(currentFrame).mockReturnValue({ frame: 0, src: BROKEN_FRAME });

    await new BackgroundView(root).apply({ kind: "auto" });
    expect(root.dataset.background).toBe("photo:autumn-forest");
    expect(root.dataset.state).toBe("ready");
    expect(root.dataset.frame).toBeUndefined();

    const shownLayer = root.querySelector(".is-visible");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(root.querySelectorAll(".is-visible")).toHaveLength(1);
    expect(root.querySelector(".is-visible")).toBe(shownLayer);
    expect(root.dataset.background).toBe("photo:autumn-forest");
  });

  it("falls back to the default photo when a frame that fails is asked for again while it decodes", async () => {
    let failDecode: (error: unknown) => void = () => undefined;
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
      this: HTMLImageElement,
    ) {
      if (!this.src.endsWith(BROKEN_FRAME)) return Promise.resolve();
      return new Promise((_resolve, reject) => {
        failDecode = reject;
      });
    });
    vi.mocked(loadDynamicWallpaper).mockResolvedValue(WALLPAPER);
    vi.mocked(currentFrame).mockReturnValue({ frame: 0, src: BROKEN_FRAME });
    const view = new BackgroundView(root);

    const first = view.apply({ kind: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = view.apply({ kind: "dynamic" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    failDecode(new DOMException("undecodable", "EncodingError"));
    await Promise.all([first, second]);
    expect(root.dataset.background).toBe("photo:autumn-forest");
  });

  it("tries a broken dynamic wallpaper frame only once", async () => {
    vi.useFakeTimers();
    vi.mocked(loadDynamicWallpaper).mockResolvedValue(WALLPAPER);
    vi.mocked(currentFrame).mockReturnValue({ frame: 0, src: BROKEN_FRAME });
    const frameDecodes: string[] = [];
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
      this: HTMLImageElement,
    ) {
      if (!this.src.endsWith(BROKEN_FRAME)) return Promise.resolve();
      frameDecodes.push(this.src);
      return Promise.reject(new DOMException("undecodable", "EncodingError"));
    });

    await new BackgroundView(root).apply({ kind: "auto" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(frameDecodes).toHaveLength(1);
    expect(root.dataset.background).toBe("photo:autumn-forest");
  });

  it("reads the upload saved with the chosen background", async () => {
    vi.mocked(readCustomBackground).mockResolvedValue(new Blob(["jpeg"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue(UPLOAD);

    await new BackgroundView(root).apply({ kind: "custom", savedAt: 42 });
    expect(readCustomBackground).toHaveBeenCalledWith(42);
    expect(root.dataset.background).toBe("custom");
  });

  it("logs a failed read of the uploaded image and shows the default photo", async () => {
    const failure = new DOMException("gone", "NotReadableError");
    vi.mocked(readCustomBackground).mockRejectedValue(failure);

    await new BackgroundView(root).apply({ kind: "custom", savedAt: 1 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("background"), failure);
    expect(root.dataset.background).toBe("photo:autumn-forest");
  });

  it("frees an uploaded image whose decode finished after a newer background was shown", async () => {
    const slowUpload = "blob:slow";
    let finishSlowDecode: (() => void) | undefined;
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
      this: HTMLImageElement,
    ) {
      if (this.src !== slowUpload) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishSlowDecode = resolve;
      });
    });
    vi.mocked(readCustomBackground).mockResolvedValue(new Blob(["jpeg"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue(slowUpload);
    const view = new BackgroundView(root);

    const custom = view.apply({ kind: "custom", savedAt: 1 });
    await vi.waitFor(() => {
      expect(finishSlowDecode).toBeDefined();
    });
    await view.apply({ kind: "photo", photo: "still-lake" });
    finishSlowDecode?.();
    await custom;

    expect(root.dataset.background).toBe("photo:still-lake");
    expect(revoked).toEqual([slowUpload]);
  });

  it("leaves the glass alone on a dark image and tints all of it on a white one", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(url);
      return Promise.resolve(new Response("avif"));
    });
    const view = new BackgroundView(root);
    await view.apply({ kind: "photo", photo: "autumn-forest" });
    expect(Object.values(tints())).toEqual([0, 0, 0, 0]);
    expect(fetched).toEqual(["backgrounds/autumn-forest.avif"]);

    image.colorAt = () => WHITE;
    await view.apply({ kind: "photo", photo: "still-lake" });
    for (const tint of Object.values(tints())) {
      expect(tint).toBeGreaterThan(0);
      expect(tint).toBeLessThan(0.95);
    }
  });

  it("tints the glass over a mid-grey image", async () => {
    image.colorAt = () => [118, 118, 118];
    await new BackgroundView(root).apply({ kind: "photo", photo: "still-lake" });
    expect(tints().sidebar).toBeGreaterThan(0);
    expect(tints().panel).toBeGreaterThan(0);
  });

  it("tints only the surfaces in front of the bright part of the image", async () => {
    image.colorAt = (x, y) => (x < 18 && y < 16 ? WHITE : DARK);
    await new BackgroundView(root).apply({ kind: "photo", photo: "still-lake" });
    expect(tints().top).toBeGreaterThan(0);
    expect(tints().sidebar).toBeGreaterThan(0);
    expect(tints().panel).toBe(0);
    expect(tints().results).toBe(0);
  });

  it("measures the part of the image the window shows, again after a resize", async () => {
    image = {
      width: 64,
      height: 16,
      colorAt: (x) => (x < 10 || x >= 54 ? WHITE : DARK),
    };
    const view = new BackgroundView(root);
    await view.apply({ kind: "photo", photo: "still-lake" });
    expect(Object.values(tints())).toEqual([0, 0, 0, 0]);
    const decodes = measured.length;

    resizeWindow(3840, 900);
    window.dispatchEvent(new Event("resize"));
    expect(tints().top).toBeGreaterThan(0);
    expect(measured).toHaveLength(decodes);
  });

  it.each([
    ["16:10", 1600, 1000, [{ resizeWidth: 128 }]],
    ["3:2", 2560, 1707, [{ resizeWidth: 128 }]],
    ["3:1", 2700, 900, [{ resizeWidth: 128 }, { resizeHeight: 80 }]],
    ["9:16", 900, 1600, [{ resizeWidth: 128 }]],
  ])(
    "measures a %s image on a grid at least 128 cells wide and 80 high",
    async (_, width, height, sizes) => {
      image = { width, height, colorAt: () => DARK };
      await new BackgroundView(root).apply({ kind: "photo", photo: "still-lake" });
      expect(decodeSizes).toEqual(sizes);
    },
  );

  it("darkens the clock for a thin bright strip behind it on a wide image", async () => {
    // 3:1, with a bright band as tall as the clock's date across the middle of the clock.
    image = { width: 2700, height: 900, colorAt: (_x, y) => (y >= 110 && y < 128 ? WHITE : DARK) };
    await new BackgroundView(root).apply({ kind: "photo", photo: "still-lake" });
    expect(tints().top).toBeGreaterThan(0.3);
  });

  it("keeps an image it couldn't measure and tints the glass to be safe", async () => {
    const failure = new DOMException("too large", "InvalidStateError");
    vi.stubGlobal("createImageBitmap", () => Promise.reject(failure));
    await new BackgroundView(root).apply({ kind: "photo", photo: "still-lake" });
    expect(root.dataset.background).toBe("photo:still-lake");
    expect(Object.values(tints())).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("measure"), failure);
  });

  it("measures an upload from its file, since the CSP lets no page fetch a blob: URL", async () => {
    const upload = new Blob(["jpeg"]);
    vi.mocked(readCustomBackground).mockResolvedValue(upload);
    vi.spyOn(URL, "createObjectURL").mockReturnValue(UPLOAD);
    const fetched = vi.fn(() => Promise.resolve(new Response("avif")));
    vi.stubGlobal("fetch", fetched);

    await new BackgroundView(root).apply({ kind: "custom", savedAt: 1 });
    expect(measured).toEqual([upload]);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("finishes a running fade before it reuses that layer for the next image", async () => {
    const view = new BackgroundView(root);
    await view.apply({ kind: "photo", photo: "still-lake" });
    const fading = root.querySelector<HTMLImageElement>(".wallpaper__frame:not(.is-visible)");
    const srcWhenFinished: (string | null | undefined)[] = [];
    const fade = {
      finish: () => srcWhenFinished.push(fading?.getAttribute("src")),
    };
    vi.spyOn(root, "getAnimations").mockReturnValue([fade as unknown as Animation]);

    await view.apply({ kind: "photo", photo: "golden-haze" });
    expect(srcWhenFinished).toEqual([null]);
    expect(fading?.src).toContain("golden-haze");
  });

  it("sets a tint by the brightest twentieth of what a surface covers", () => {
    const cells = (brightShare: number) =>
      Array.from({ length: 100 }, (_, index) => (index < brightShare * 100 ? 1 : 0));
    expect(tintOver(cells(0), 0.05)).toBe(0);
    expect(tintOver(cells(0.04), 0.05)).toBe(0);
    expect(tintOver(cells(0.1), 0.05)).toBe(tintOver(cells(1), 0.05));
    expect(tintOver([0.04], 0.05)).toBe(0);
    expect(tintOver([0.5], 0.05)).toBeGreaterThan(0);
    expect(tintOver([0.5], 0.05)).toBeLessThan(tintOver([1], 0.05));
  });

  it("leaves the wallpaper alone while the tab is hidden and catches up once it is shown", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.mocked(loadDynamicWallpaper).mockResolvedValue(WALLPAPER);
    vi.mocked(currentFrame).mockReturnValue({ frame: 0, src: "wallpapers/frame.jpg" });
    await new BackgroundView(root).apply({ kind: "auto" });
    vi.mocked(currentFrame).mockReturnValue({ frame: 1, src: "wallpapers/next.jpg" });

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(root.dataset.frame).toBe("0");

    hidden.mockReturnValue(false);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(root.dataset.frame).toBe("1");
    });
  });
});
