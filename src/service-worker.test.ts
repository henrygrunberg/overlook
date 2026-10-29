import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookmarkNode } from "./bookmarks/library";

const sync = vi.hoisted(() => ({
  ensure: vi.fn<(urls: readonly string[], force?: boolean) => Promise<void>>(),
  pruneExcept: vi.fn<(urls: readonly string[]) => Promise<void>>(),
}));
vi.mock("./favicons/icon-sync", () => ({
  IconSync: class {
    ensure = sync.ensure;
    pruneExcept = sync.pruneExcept;
  },
}));

type Listener = (...args: unknown[]) => void;

function fakeEvent() {
  const listeners: Listener[] = [];
  return {
    addListener: (listener: (...args: never[]) => void) => listeners.push(listener as Listener),
    fire: (...args: unknown[]) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

const LIBRARY = ["https://docs.example.com/", "https://gear.example.com/"];

const treeOf = (urls: readonly string[]): BookmarkNode[] => [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        title: "Bookmarks bar",
        children: urls.map((url, index) => ({ id: `b${index}`, title: `Site ${index}`, url })),
      },
    ],
  },
];

const chromeEvents = () => ({
  onInstalled: fakeEvent(),
  onStartup: fakeEvent(),
  onMessage: fakeEvent(),
  onImportBegan: fakeEvent(),
  onImportEnded: fakeEvent(),
  onCreated: fakeEvent(),
  onChanged: fakeEvent(),
});
let events: ReturnType<typeof chromeEvents>;
let tree: BookmarkNode[];
const getPlatformInfo = vi.fn(() => Promise.resolve());
const fetchFile = vi.fn<(url: string) => Promise<Response>>();
const storageSet = vi.fn<(items: Record<string, unknown>) => Promise<void>>();

const created = (url: string) => {
  events.onCreated.fire("new", { url });
};

beforeEach(async () => {
  vi.useFakeTimers();
  sync.ensure.mockResolvedValue();
  sync.pruneExcept.mockResolvedValue();
  fetchFile.mockRejectedValue(new TypeError("Failed to fetch"));
  storageSet.mockResolvedValue();
  vi.stubGlobal("fetch", fetchFile);
  events = chromeEvents();
  tree = treeOf(LIBRARY);
  const { onInstalled, onStartup, onMessage, ...bookmarkEvents } = events;
  vi.stubGlobal("chrome", {
    runtime: { id: "overlook", getPlatformInfo, onInstalled, onStartup, onMessage },
    bookmarks: { getTree: () => Promise.resolve(tree), ...bookmarkEvents },
    storage: { local: { set: storageSet } },
  });
  vi.resetModules();
  await import("./service-worker");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("background icon sync", () => {
  it("syncs a burst of new bookmarks together once it settles", async () => {
    created("https://a.example.com/");
    created("https://b.example.com/");
    events.onChanged.fire("2", { url: "https://c.example.com/" });
    await vi.advanceTimersByTimeAsync(999);
    expect(sync.ensure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sync.ensure).toHaveBeenCalledExactlyOnceWith([
      "https://a.example.com/",
      "https://b.example.com/",
      "https://c.example.com/",
    ]);
  });

  it("ignores bookmarks created by an import, then syncs and prunes the whole library", async () => {
    events.onImportBegan.fire();
    created("https://a.example.com/");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync.ensure).not.toHaveBeenCalled();

    events.onImportEnded.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.ensure).toHaveBeenCalledExactlyOnceWith(LIBRARY);
    expect(sync.pruneExcept).toHaveBeenCalledExactlyOnceWith(LIBRARY);
  });

  it("keeps the icons of bookmarks added while the whole library was syncing", async () => {
    const { promise: syncing, resolve: finishSync } = Promise.withResolvers<undefined>();
    sync.ensure.mockReturnValueOnce(syncing);
    events.onStartup.fire();
    await vi.advanceTimersByTimeAsync(0);

    const added = "https://new.example.com/";
    tree = treeOf([...LIBRARY, added]);
    created(added);
    await vi.advanceTimersByTimeAsync(1000);
    finishSync(undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(sync.pruneExcept).toHaveBeenCalledExactlyOnceWith([...LIBRARY, added]);
  });

  it("deletes no icons when the bookmarks read as empty after a sync", async () => {
    const { promise: syncing, resolve: finishSync } = Promise.withResolvers<undefined>();
    sync.ensure.mockReturnValueOnce(syncing);
    events.onStartup.fire();
    await vi.advanceTimersByTimeAsync(0);

    tree = treeOf([]);
    finishSync(undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(sync.pruneExcept).not.toHaveBeenCalled();
  });

  it.each(["onInstalled", "onStartup"] as const)(
    "syncs and prunes the whole library on %s",
    async (trigger) => {
      events[trigger].fire();
      await vi.advanceTimersByTimeAsync(0);
      expect(sync.ensure).toHaveBeenCalledExactlyOnceWith(LIBRARY);
      expect(sync.pruneExcept).toHaveBeenCalledExactlyOnceWith(LIBRARY);
    },
  );

  it("keeps the worker alive with one timer however many syncs overlap", async () => {
    const finish: (() => void)[] = [];
    sync.ensure.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    const message = { type: "ensure-icons", urls: ["https://a.example.com/"] };
    events.onMessage.fire(message, { id: "overlook" });
    events.onMessage.fire(message, { id: "overlook" });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(getPlatformInfo).toHaveBeenCalledOnce();

    for (const resolve of finish) resolve();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getPlatformInfo).toHaveBeenCalledOnce();
  });

  it("ignores messages from other extensions", () => {
    events.onMessage.fire({ type: "refresh-icons", urls: [] }, { id: "another-extension" });
    expect(sync.ensure).not.toHaveBeenCalled();
  });
});

describe("background wallpaper check", () => {
  it.each(["onInstalled", "onStartup"] as const)(
    "records that a dynamic wallpaper is installed on %s",
    async (trigger) => {
      fetchFile.mockResolvedValue(new Response("{}"));
      events[trigger].fire();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFile).toHaveBeenCalledExactlyOnceWith("wallpapers/manifest.json");
      expect(storageSet).toHaveBeenCalledExactlyOnceWith({ wallpaperInstalled: true });
    },
  );

  it("records that none is installed when its manifest can't be fetched", async () => {
    events.onInstalled.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(storageSet).toHaveBeenCalledExactlyOnceWith({ wallpaperInstalled: false });
  });
});
