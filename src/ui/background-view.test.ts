import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundView } from "./background-view";
import type { WallpaperManifest } from "../wallpaper/schedule";
import { readCustomBackground } from "../backgrounds/custom-background";
import { currentFrame, loadDynamicWallpaper } from "../wallpaper/dynamic-wallpaper";

vi.mock("../backgrounds/custom-background", () => ({ readCustomBackground: vi.fn() }));
vi.mock("../wallpaper/dynamic-wallpaper", () => ({
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

describe("BackgroundView", () => {
  let root: HTMLElement;
  const revoked: string[] = [];

  beforeEach(() => {
    root = document.createElement("div");
    revoked.length = 0;
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
  });

  afterEach(() => {
    vi.useRealTimers();
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
