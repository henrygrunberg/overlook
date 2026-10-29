import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentFrame } from "./dynamic-wallpaper";
import { parseManifest } from "./schedule";

async function loadWith({
  installed,
  response,
}: {
  installed: unknown;
  response?: Response | Error;
}) {
  vi.resetModules();
  const storageSet = vi.fn(() => Promise.resolve());
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: () => Promise.resolve({ wallpaperInstalled: installed }),
        set: storageSet,
      },
    },
  });
  const fetchManifest = vi.fn(() =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response ?? new Response("", { status: 404 })),
  );
  vi.stubGlobal("fetch", fetchManifest);
  const { loadDynamicWallpaper } = await import("./dynamic-wallpaper");
  return { wallpaper: await loadDynamicWallpaper(), fetchManifest, storageSet };
}

const MANIFEST = {
  version: 1,
  mode: "time",
  frames: ["day.jpg"],
  schedule: [{ frame: 0, dayFraction: 0 }],
};

describe("loadDynamicWallpaper", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  beforeEach(() => {
    warn.mockClear();
  });

  it("loads the installed wallpaper", async () => {
    const { wallpaper, storageSet } = await loadWith({
      installed: true,
      response: new Response(JSON.stringify(MANIFEST)),
    });
    expect(wallpaper?.schedule).toEqual([{ frame: 0, file: "day.jpg", dayFraction: 0 }]);
    expect(storageSet).not.toHaveBeenCalled();
  });

  it.each([undefined, false, "true"])(
    "requests nothing when the service worker found no wallpaper (%s)",
    async (installed) => {
      const { wallpaper, fetchManifest } = await loadWith({ installed });
      expect(wallpaper).toBeNull();
      expect(fetchManifest).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["is gone", new Response("", { status: 404 })],
    ["can't be fetched", new TypeError("Failed to fetch")],
  ])(
    "tells the other tabs no wallpaper is installed when its manifest %s",
    async (_label, response) => {
      const { wallpaper, storageSet } = await loadWith({ installed: true, response });
      expect(wallpaper).toBeNull();
      expect(storageSet).toHaveBeenCalledExactlyOnceWith({ wallpaperInstalled: false });
    },
  );

  it("keeps the installed flag when the manifest is there but invalid", async () => {
    const { storageSet } = await loadWith({
      installed: true,
      response: new Response(JSON.stringify({ ...MANIFEST, frames: [] })),
    });
    expect(storageSet).not.toHaveBeenCalled();
  });

  it.each([
    ["is invalid", new Response(JSON.stringify({ ...MANIFEST, frames: [] }))],
    ["is gone", new Response("", { status: 404 })],
  ])("warns when the installed wallpaper's manifest %s", async (_label, response) => {
    const { wallpaper } = await loadWith({ installed: true, response });
    expect(wallpaper).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("wallpapers/manifest.json"),
      expect.any(Error),
    );
  });
});

describe("currentFrame", () => {
  it("points at the frame file inside the wallpaper folder", () => {
    expect(currentFrame(parseManifest(MANIFEST))).toEqual({ frame: 0, src: "wallpapers/day.jpg" });
  });
});
