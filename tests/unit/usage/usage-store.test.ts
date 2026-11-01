import { describe, expect, it, vi } from "vitest";
import { UsageStore } from "../../../src/usage/usage-store";
import { memoryStorage } from "../fixtures/memory-storage";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28);
const A = "https://a.example.com";
const B = "https://b.example.com";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("UsageStore", () => {
  it("ranks frequently opened bookmarks first", async () => {
    const store = await UsageStore.load(memoryStorage().storage);
    await store.recordVisit("https://a.example.com", NOW);
    await store.recordVisit("https://b.example.com", NOW);
    await store.recordVisit("https://b.example.com", NOW);

    expect(store.mostUsed(5, NOW)).toEqual(["https://b.example.com", "https://a.example.com"]);
  });

  it("lets old visits fade so recent habits win", async () => {
    const store = await UsageStore.load(memoryStorage().storage);
    for (let i = 0; i < 4; i++) await store.recordVisit("https://old.example.com", NOW - 60 * DAY);
    await store.recordVisit("https://new.example.com", NOW);

    expect(store.mostUsed(1, NOW)).toEqual(["https://new.example.com"]);
    expect(store.frecency("https://old.example.com", NOW)).toBeCloseTo(4 * 0.5 ** (60 / 14));
  });

  it("persists visits and reloads them", async () => {
    const { storage } = memoryStorage();
    const store = await UsageStore.load(storage);
    await store.recordVisit("https://a.example.com", NOW);

    const reloaded = await UsageStore.load(storage);
    expect(reloaded.frecency("https://a.example.com", NOW)).toBe(1);
  });

  it("counts every visit when several are recorded at once", async () => {
    const store = await UsageStore.load(memoryStorage().storage);
    await Promise.all([
      store.recordVisit("https://a.example.com", NOW),
      store.recordVisit("https://b.example.com", NOW),
      store.recordVisit("https://a.example.com", NOW),
    ]);
    expect(store.frecency("https://a.example.com", NOW)).toBe(2);
    expect(store.frecency("https://b.example.com", NOW)).toBe(1);
  });

  it("counts both of two simultaneous visits to a stored URL", async () => {
    const { storage } = memoryStorage({ usage: { [A]: { score: 5, lastUsed: NOW } } });
    const store = await UsageStore.load(storage);
    await Promise.all([store.recordVisit(A, NOW), store.recordVisit(A, NOW)]);
    expect(store.frecency(A, NOW)).toBe(7);
  });

  it("keeps every visit when two tabs record at the same time", async () => {
    const { storage } = memoryStorage({ usage: { [A]: { score: 5, lastUsed: NOW } } });
    const [firstTab, secondTab] = await Promise.all([
      UsageStore.load(storage),
      UsageStore.load(storage),
    ]);
    await Promise.all([
      firstTab.recordVisit(A, NOW),
      secondTab.recordVisit(B, NOW),
      secondTab.recordVisit(A, NOW),
    ]);

    const reloaded = await UsageStore.load(storage);
    expect(reloaded.frecency(A, NOW)).toBe(7);
    expect(reloaded.frecency(B, NOW)).toBe(1);
  });

  it("keeps recording after a write fails", async () => {
    const { storage, data, failNextWrite } = memoryStorage();
    const store = await UsageStore.load(storage);
    failNextWrite();
    const first = store.recordVisit(A, NOW);
    const second = store.recordVisit(B, NOW);
    await expect(first).rejects.toThrow("quota exceeded");
    await second;
    expect(data.usage).toHaveProperty([B]);
  });

  it("sees visits that another tab records, and says so", async () => {
    const { storage } = memoryStorage();
    const [firstTab, secondTab] = await Promise.all([
      UsageStore.load(storage),
      UsageStore.load(storage),
    ]);
    const heard = vi.fn();
    firstTab.subscribe(heard);

    await secondTab.recordVisit(A, NOW);
    await settle();
    expect(firstTab.frecency(A, NOW)).toBe(1);
    expect(heard).toHaveBeenCalledOnce();
  });

  it("starts empty when the history can't be read, and still saves new visits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { storage, data } = memoryStorage({ usage: { [A]: { score: 3, lastUsed: NOW } } });
    vi.spyOn(storage, "get").mockRejectedValueOnce(new Error("unavailable"));
    const store = await UsageStore.load(storage);
    expect(store.frecency(A, NOW)).toBe(0);

    await store.recordVisit(B, NOW);
    expect(Object.keys(data.usage as object).sort()).toEqual([A, B]);
  });

  it.each([
    ["an infinite score", { score: Infinity, lastUsed: NOW }],
    ["a score that isn't a number", { score: Number.NaN, lastUsed: NOW }],
    ["an infinite time", { score: 2, lastUsed: Infinity }],
  ])("ignores a stored record with %s", async (_label, record) => {
    const store = await UsageStore.load(memoryStorage({ usage: { [A]: record } }).storage);
    expect(store.mostUsed(5, NOW)).toEqual([]);
  });

  it("lets a record dated in the future fade from now on", async () => {
    const future = Date.now() + 365 * DAY;
    const store = await UsageStore.load(
      memoryStorage({ usage: { [A]: { score: 4, lastUsed: future } } }).storage,
    );
    expect(store.frecency(A, Date.now() + 14 * DAY)).toBeCloseTo(2);
  });

  it("doesn't record a URL too long to keep, and drops one already stored", async () => {
    const long = `https://a.example.com/#${"x".repeat(9000)}`;
    const { storage, data } = memoryStorage({ usage: { [long]: { score: 1, lastUsed: NOW } } });
    const set = vi.spyOn(storage, "set");
    const store = await UsageStore.load(storage);
    expect(store.frecency(long, NOW)).toBe(0);

    await store.recordVisit(long, NOW);
    expect(set).not.toHaveBeenCalled();
    await store.recordVisit(B, NOW);
    expect(Object.keys(data.usage as object)).toEqual([B]);
  });

  it("keeps visits recorded by another open new tab", async () => {
    const { storage } = memoryStorage();
    const firstTab = await UsageStore.load(storage);
    const secondTab = await UsageStore.load(storage);
    await secondTab.recordVisit("https://x.example.com", NOW);
    await firstTab.recordVisit("https://y.example.com", NOW);

    const reloaded = await UsageStore.load(storage);
    expect(reloaded.mostUsed(5, NOW).sort()).toEqual([
      "https://x.example.com",
      "https://y.example.com",
    ]);
  });

  it("can leave out URLs, e.g. of deleted bookmarks, before applying the limit", async () => {
    const store = await UsageStore.load(memoryStorage().storage);
    for (let i = 0; i < 3; i++) await store.recordVisit("https://gone.example.com", NOW);
    await store.recordVisit("https://kept.example.com", NOW);

    expect(store.mostUsed(1, NOW, (url) => url !== "https://gone.example.com")).toEqual([
      "https://kept.example.com",
    ]);
  });

  it("ignores corrupt stored data", async () => {
    const { storage } = memoryStorage({
      usage: {
        "https://ok.example.com": { score: 2, lastUsed: NOW },
        "https://bad.example.com": { score: "x" },
      },
    });
    const store = await UsageStore.load(storage);

    expect(store.mostUsed(5, NOW)).toEqual(["https://ok.example.com"]);
  });

  it("caps the boost for search ranking", async () => {
    const store = await UsageStore.load(memoryStorage().storage);
    for (let i = 0; i < 200; i++) await store.recordVisit("https://a.example.com", NOW);

    expect(store.boost("https://a.example.com", NOW)).toBe(0.3);
    expect(store.boost("https://never.example.com", NOW)).toBe(0);
  });

  it("keeps at most 500 records, dropping the least used", async () => {
    const { storage, data } = memoryStorage();
    const store = await UsageStore.load(storage);
    await store.recordVisit("https://favourite.example.com", NOW);
    await store.recordVisit("https://favourite.example.com", NOW);
    for (let i = 0; i < 500; i++)
      await store.recordVisit(`https://site${i}.example.com`, NOW - DAY);

    const saved = data.usage as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(500);
    expect(saved).toHaveProperty(["https://favourite.example.com"]);
  });
  it("doesn't tell its own tab about the visits it records", async () => {
    const store = await UsageStore.load(memoryStorage().storage);
    const heard = vi.fn();
    store.subscribe(heard);

    await store.recordVisit(B, NOW);
    await store.recordVisit(A, NOW);
    await settle();
    expect(store.frecency(A, NOW)).toBe(1);
    expect(heard).not.toHaveBeenCalled();
  });

  it("keeps another tab's visit heard while its first read was under way", async () => {
    const { storage } = memoryStorage();
    let finishRead: (stored: Record<string, unknown>) => void = () => undefined;
    vi.spyOn(storage, "get").mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const loading = UsageStore.load(storage);
    await storage.set({ usage: { [A]: { score: 2, lastUsed: NOW } } });
    await settle();
    finishRead({});
    expect((await loading).frecency(A, NOW)).toBe(2);
  });

  it("never drops the visit it is recording to make room", async () => {
    const usage = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `https://site${index}.example.com`,
        { score: 5, lastUsed: NOW },
      ]),
    );
    const { storage, data } = memoryStorage({ usage });
    const store = await UsageStore.load(storage);

    await store.recordVisit(A, NOW);
    const saved = data.usage as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(500);
    expect(saved).toHaveProperty([A]);
  });
});
