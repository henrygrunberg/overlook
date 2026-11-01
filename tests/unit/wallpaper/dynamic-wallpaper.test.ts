import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { currentFrame } from "../../../src/wallpaper/dynamic-wallpaper";
import { parseManifest } from "../../../src/wallpaper/schedule";

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

async function loadWith({
  installed: initiallyInstalled,
  response,
}: {
  installed: unknown;
  response?: Response | Error;
}) {
  let installed = initiallyInstalled;
  vi.resetModules();
  const storageSet = vi.fn(() => Promise.resolve());
  const storageGet = vi.fn(() => Promise.resolve({ wallpaperInstalled: installed }));
  const listeners: StorageListener[] = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: storageGet, set: storageSet },
      onChanged: { addListener: (listener: StorageListener) => listeners.push(listener) },
    },
  });
  const changeFlag = (value: unknown, area = "local") => {
    installed = value;
    for (const listener of listeners) listener({ wallpaperInstalled: { newValue: value } }, area);
  };
  const fetchManifest = vi.fn(() =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response ?? new Response("", { status: 404 })),
  );
  vi.stubGlobal("fetch", fetchManifest);
  const { loadDynamicWallpaper, watchDynamicWallpaper } =
    await import("../../../src/wallpaper/dynamic-wallpaper");
  return {
    wallpaper: await loadDynamicWallpaper(),
    loadDynamicWallpaper,
    watchDynamicWallpaper,
    fetchManifest,
    storageGet,
    storageSet,
    changeFlag,
  };
}

const MANIFEST = {
  version: 1,
  mode: "time",
  frames: ["day.jpg"],
  schedule: [{ frame: 0, dayFraction: 0 }],
};

describe("loadDynamicWallpaper", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

describe("loadDynamicWallpaper once the service worker has looked", () => {
  it("loads a wallpaper found after the page first asked, and says so", async () => {
    const loaded = await loadWith({
      installed: false,
      response: new Response(JSON.stringify(MANIFEST)),
    });
    const changed = vi.fn();
    loaded.watchDynamicWallpaper(changed);
    expect(loaded.wallpaper).toBeNull();

    loaded.changeFlag(true);
    expect(changed).toHaveBeenCalledOnce();
    expect((await loaded.loadDynamicWallpaper())?.schedule).toHaveLength(1);
  });

  it("ignores other changes", async () => {
    const loaded = await loadWith({ installed: false });
    const changed = vi.fn();
    loaded.watchDynamicWallpaper(changed);
    loaded.changeFlag(true, "sync");
    expect(changed).not.toHaveBeenCalled();
    expect(await loaded.loadDynamicWallpaper()).toBeNull();
  });

  it("asks again after the flag couldn't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loaded = await loadWith({
      installed: true,
      response: new Response(JSON.stringify(MANIFEST)),
    });
    loaded.watchDynamicWallpaper(() => undefined);
    loaded.storageGet.mockRejectedValueOnce(new Error("unavailable"));
    loaded.changeFlag(true);
    expect(await loaded.loadDynamicWallpaper()).toBeNull();
    expect(warn).toHaveBeenCalled();

    loaded.fetchManifest.mockResolvedValueOnce(new Response(JSON.stringify(MANIFEST)));
    expect(await loaded.loadDynamicWallpaper()).not.toBeNull();
  });
});

describe("currentFrame", () => {
  it("points at the frame file inside the wallpaper folder", () => {
    expect(currentFrame(parseManifest(MANIFEST))).toEqual({ frame: 0, src: "wallpapers/day.jpg" });
  });
});
