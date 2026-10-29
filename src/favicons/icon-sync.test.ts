import { describe, expect, it, vi } from "vitest";
import type { IconLookup } from "./fetch-icon";
import type { IconRecord } from "./icon-store";
import { IconSync, type IconSyncDeps } from "./icon-sync";

const NOW = Date.UTC(2026, 9, 28);
const DAY = 86_400_000;
const HOUR = 3_600_000;

const findIcon: IconSyncDeps["fetchIcon"] = (origin) =>
  Promise.resolve({ image: new Blob([origin]), fullBleed: false });

const cachedIcon = (origin: string, fetchedAt: number, failedAttempts?: number): IconRecord => ({
  origin,
  status: "ok",
  image: new Blob(["cached"]),
  fullBleed: true,
  fetchedAt,
  ...(failedAttempts === undefined ? {} : { failedAttempts }),
});

function setup(stored: IconRecord[] = [], fetcher: IconSyncDeps["fetchIcon"] = findIcon) {
  const records = new Map(stored.map((record) => [record.origin, record]));
  const fetchIcon = vi.fn(fetcher);
  const announce = vi.fn();
  const deps: IconSyncDeps = {
    fetchIcon,
    read: (origin) => Promise.resolve(records.get(origin)),
    readAll: () => Promise.resolve([...records.values()]),
    readOrigins: () => Promise.resolve([...records.keys()]),
    write: (record) => {
      records.set(record.origin, record);
      return Promise.resolve();
    },
    remove: (origins) => {
      for (const origin of origins) records.delete(origin);
      return Promise.resolve();
    },
    announce,
    now: () => NOW,
  };
  return { sync: new IconSync(deps), deps, records, fetchIcon, announce };
}

const fetchedOrigins = (fetchIcon: ReturnType<typeof setup>["fetchIcon"]) =>
  fetchIcon.mock.calls.map(([origin]) => origin).sort();

describe("IconSync", () => {
  it("fetches each site once, however many bookmarks it has", async () => {
    const { sync, fetchIcon, records, announce } = setup();
    await sync.ensure([
      "https://a.example.com/one",
      "https://a.example.com/two",
      "https://b.example.com/",
      "chrome://settings",
      "not a url",
    ]);

    expect(fetchIcon.mock.calls.map(([origin]) => origin)).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(records.get("https://a.example.com")).toMatchObject({ status: "ok", fetchedAt: NOW });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("refreshes icons after 30 days and sites without one after a day", async () => {
    const { sync, fetchIcon } = setup([
      cachedIcon("https://fresh.example.com", NOW - 29 * DAY),
      cachedIcon("https://stale.example.com", NOW - 31 * DAY),
      {
        origin: "https://recent-miss.example.com",
        status: "missing",
        fetchedAt: NOW - HOUR,
        failedAttempts: 1,
      },
      {
        origin: "https://retry.example.com",
        status: "missing",
        fetchedAt: NOW - 2 * DAY,
        failedAttempts: 1,
      },
    ]);
    await sync.ensure([
      "https://fresh.example.com",
      "https://stale.example.com",
      "https://recent-miss.example.com",
      "https://retry.example.com",
    ]);

    expect(fetchedOrigins(fetchIcon)).toEqual([
      "https://retry.example.com",
      "https://stale.example.com",
    ]);
  });

  it("refetches everything when forced", async () => {
    const { sync, fetchIcon } = setup([cachedIcon("https://fresh.example.com", NOW)]);
    await sync.ensure(["https://fresh.example.com"], true);
    expect(fetchIcon).toHaveBeenCalledOnce();
  });

  it("fetches nothing when the cached icons can't be read, unless asked to refresh", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, fetchIcon } = setup();
    const sync = new IconSync({
      ...deps,
      readAll: () => Promise.reject(new Error("disk is full")),
    });

    await sync.ensure(["https://a.example.com/"]);
    expect(fetchIcon).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();

    await sync.ensure(["https://a.example.com/"], true);
    expect(fetchIcon).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("fetches a site once when two syncs ask for it at the same time", async () => {
    const { sync, fetchIcon } = setup();
    await Promise.all([
      sync.ensure(["https://a.example.com/"]),
      sync.ensure(["https://a.example.com/x"]),
    ]);
    expect(fetchIcon).toHaveBeenCalledOnce();
  });

  it("remembers sites without a usable icon so it doesn't retry on every new tab", async () => {
    const { sync, records } = setup([], () => Promise.resolve("missing"));
    await sync.ensure(["https://no-icon.example.com"]);
    expect(records.get("https://no-icon.example.com")).toEqual({
      origin: "https://no-icon.example.com",
      status: "missing",
      fetchedAt: NOW,
      failedAttempts: 1,
    });
  });

  it("backs off a site that still has no usable icon, without telling open tabs", async () => {
    const origin = "https://no-icon.example.com";
    const { sync, records, announce } = setup(
      [{ origin, status: "missing", fetchedAt: NOW - 2 * DAY, failedAttempts: 1 }],
      () => Promise.resolve("missing"),
    );
    await sync.ensure([origin]);

    expect(records.get(origin)).toEqual({
      origin,
      status: "missing",
      fetchedAt: NOW,
      failedAttempts: 2,
    });
    expect(announce).not.toHaveBeenCalled();
  });

  it.each<IconLookup>(["unreachable", "missing"])(
    "keeps a cached icon when a refresh finds it %s",
    async (lookup) => {
      const stale = cachedIcon("https://intranet.example.com", NOW - 31 * DAY);
      const { sync, records, announce } = setup([stale], () => Promise.resolve(lookup));
      await sync.ensure(["https://intranet.example.com/"], true);

      expect(records.get(stale.origin)).toEqual({ ...stale, fetchedAt: NOW, failedAttempts: 1 });
      expect(announce).not.toHaveBeenCalled();
    },
  );

  it("counts the checks a site it never reached has failed, without telling open tabs", async () => {
    const origin = "https://intranet.example.com";
    const { sync, records, announce } = setup([], () => Promise.resolve("unreachable"));
    await sync.ensure([origin], true);
    await sync.ensure([origin], true);

    expect(records.get(origin)).toEqual({
      origin,
      status: "unreachable",
      fetchedAt: NOW,
      failedAttempts: 2,
    });
    expect(announce).not.toHaveBeenCalled();
  });

  it("tells open tabs once a site it never reached answers without a usable icon", async () => {
    const origin = "https://intranet.example.com";
    const { sync, records, announce } = setup(
      [{ origin, status: "unreachable", fetchedAt: NOW - 2 * DAY, failedAttempts: 1 }],
      () => Promise.resolve("missing"),
    );
    await sync.ensure([origin]);

    expect(records.get(origin)).toEqual({
      origin,
      status: "missing",
      fetchedAt: NOW,
      failedAttempts: 2,
    });
    expect(announce).toHaveBeenCalledExactlyOnceWith(origin);
  });

  it("still knows a site has no usable icon after it goes out of reach", async () => {
    const origin = "https://intranet.example.com";
    const { sync, records, announce } = setup(
      [{ origin, status: "missing", fetchedAt: NOW - 2 * DAY, failedAttempts: 1 }],
      () => Promise.resolve("unreachable"),
    );
    await sync.ensure([origin]);

    expect(records.get(origin)).toMatchObject({ status: "missing", failedAttempts: 2 });
    expect(announce).not.toHaveBeenCalled();
  });

  it("starts counting again once an unreachable site answers", async () => {
    const origin = "https://intranet.example.com";
    const { sync, records, announce } = setup([
      { origin, status: "unreachable", fetchedAt: NOW - 5 * DAY, failedAttempts: 3 },
    ]);
    await sync.ensure([origin]);
    expect(records.get(origin)).toMatchObject({ status: "ok" });
    expect(records.get(origin)).not.toHaveProperty("failedAttempts");
    expect(announce).toHaveBeenCalledExactlyOnceWith(origin);
  });

  it("writes nothing when fetching fails, and tries again on the next sync", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sync, records, announce, fetchIcon } = setup([], () =>
      Promise.reject(new Error("worker crashed")),
    );
    await sync.ensure(["https://a.example.com"]);
    await sync.ensure(["https://a.example.com"]);

    expect(records.size).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    expect(fetchIcon).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("downloads at most four sites at once", async () => {
    let running = 0;
    let peak = 0;
    const { sync } = setup([], async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return "missing";
    });
    await sync.ensure(Array.from({ length: 10 }, (_, index) => `https://site${index}.example.com`));

    expect(peak).toBe(4);
  });

  it("deletes the icons of sites that no longer have a bookmark", async () => {
    const { sync, records } = setup([
      cachedIcon("https://kept.example.com", NOW),
      cachedIcon("https://deleted.example.com", NOW),
    ]);
    await sync.pruneExcept(["https://kept.example.com/page"]);
    expect([...records.keys()]).toEqual(["https://kept.example.com"]);
  });

  it("also deletes stored records it can't read", async () => {
    const { deps } = setup([cachedIcon("https://kept.example.com", NOW)]);
    const remove = vi.fn(deps.remove);
    const sync = new IconSync({
      ...deps,
      readOrigins: () =>
        Promise.resolve(["https://kept.example.com", "https://corrupt.example.com"]),
      remove,
    });
    await sync.pruneExcept(["https://kept.example.com/page"]);
    expect(remove).toHaveBeenCalledExactlyOnceWith(["https://corrupt.example.com"]);
  });
});
