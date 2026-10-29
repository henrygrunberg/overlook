import { describe, expect, it } from "vitest";
import { UsageStore, type UsageStorage } from "./usage-store";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28);

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const storage: UsageStorage = {
    get: () => Promise.resolve({ ...data }),
    set: (items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
  return { storage, data };
}

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
});
