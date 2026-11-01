import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, toggleFavourite } from "../../../src/settings/settings";
import { SettingsStore } from "../../../src/settings/settings-store";

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

function fakeStorage({
  failedReads = 0,
  stored: initial,
}: { failedReads?: number; stored?: unknown } = {}) {
  let readsToFail = failedReads;
  let writesToFail = 0;
  let stored = initial;
  const listeners: ChangeListener[] = [];
  const heldReads: (() => void)[] = [];
  let holdingReads = false;
  const announce = (area = "local") => {
    const value = stored;
    void Promise.resolve().then(() => {
      for (const listener of listeners) listener({ settings: { newValue: value } }, area);
    });
  };
  const writes: unknown[] = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: () => {
          if (readsToFail > 0) {
            readsToFail--;
            return Promise.reject(new Error("unavailable"));
          }
          const served = { settings: stored };
          if (!holdingReads) return Promise.resolve(served);
          return new Promise((resolve) => {
            heldReads.push(() => {
              resolve(served);
            });
          });
        },
        set: (items: Record<string, unknown>) => {
          writes.push(items.settings);
          if (writesToFail > 0) {
            writesToFail--;
            return Promise.reject(new Error("quota exceeded"));
          }
          stored = items.settings;
          announce();
          return Promise.resolve();
        },
      },
      onChanged: { addListener: (listener: ChangeListener) => listeners.push(listener) },
    },
  });
  return {
    writes,
    heldReads,
    stored: () => stored,
    holdReads: (hold = true) => {
      holdingReads = hold;
    },
    failNextWrite: () => {
      writesToFail++;
    },
    writeFromOtherTab: (value: unknown, area = "local") => {
      stored = value;
      announce(area);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const HOME_WITHOUT_FREQUENT = { ...DEFAULT_SETTINGS.home, showFrequent: false };

describe("SettingsStore", () => {
  it("falls back to the defaults when storage can't be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeStorage({ failedReads: 1 });
    const settings = await SettingsStore.load();
    expect(settings.current).toEqual(DEFAULT_SETTINGS);
    expect(settings.loadFailed).toBe(true);
  });

  it("applies a change worked out from the stored settings even after a failed load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage({
      failedReads: 1,
      stored: { ...DEFAULT_SETTINGS, favourites: ["saved"] },
    });
    const settings = await SettingsStore.load();

    await settings.update((stored) => ({ favourites: toggleFavourite(stored.favourites, "new") }));
    expect(storage.stored()).toMatchObject({ favourites: ["saved", "new"] });
    expect(settings.current.favourites).toEqual(["saved", "new"]);
    expect(settings.loadFailed).toBe(false);
  });

  it("writes nothing when storage still can't be read after a failed load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage({ failedReads: 2 });
    const settings = await SettingsStore.load();

    await expect(
      settings.update((stored) => ({ favourites: toggleFavourite(stored.favourites, "a") })),
    ).rejects.toThrow("unavailable");
    expect(storage.writes).toEqual([]);
    expect(settings.current).toEqual(DEFAULT_SETTINGS);
    expect(settings.loadFailed).toBe(true);
  });

  it("ends the fallback to the defaults when another tab saves settings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage({ failedReads: 1 });
    const settings = await SettingsStore.load();

    storage.writeFromOtherTab({ ...DEFAULT_SETTINGS, favourites: ["x"] });
    await settle();
    expect(settings.loadFailed).toBe(false);
    expect(settings.current.favourites).toEqual(["x"]);
  });

  it("says when the settings came from storage", async () => {
    fakeStorage();
    expect((await SettingsStore.load()).loadFailed).toBe(false);
  });

  it("adopts changes made in other tabs", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    const heard: unknown[] = [];
    settings.subscribe((current) => heard.push(current.favourites));

    storage.writeFromOtherTab({ favourites: ["x"] });
    await settle();
    expect(settings.current.favourites).toEqual(["x"]);
    expect(heard).toEqual([["x"]]);
  });

  it("ignores changes in other storage areas", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    const heard: unknown[] = [];
    settings.subscribe((current) => heard.push(current));

    storage.writeFromOtherTab({ favourites: ["x"] }, "sync");
    await settle();
    expect(heard).toEqual([]);
    expect(settings.current.favourites).toEqual([]);
  });

  it("hears another tab's change made while its first read was under way", async () => {
    const storage = fakeStorage({ stored: { favourites: ["old"] } });
    storage.holdReads();
    const loading = SettingsStore.load();
    await vi.waitFor(() => {
      expect(storage.heldReads).toHaveLength(1);
    });
    storage.writeFromOtherTab({ favourites: ["new"] });
    await vi.waitFor(() => {
      expect(storage.heldReads).toHaveLength(2);
    });
    for (const release of storage.heldReads) release();
    const settings = await loading;
    await settle();

    expect(settings.current.favourites).toEqual(["new"]);
  });

  it("notifies once per change, not again for the event of its own write", async () => {
    fakeStorage();
    const settings = await SettingsStore.load();
    const heard: unknown[] = [];
    settings.subscribe((current) => heard.push(current.favourites));

    await settings.update(() => ({ favourites: ["a"] }));
    await settle();
    expect(heard).toEqual([["a"]]);
  });

  it("keeps both changes when two tabs save different settings at once", async () => {
    const storage = fakeStorage();
    const [firstTab, secondTab] = await Promise.all([SettingsStore.load(), SettingsStore.load()]);

    await Promise.all([
      firstTab.update(() => ({ favourites: ["new-pin"] })),
      secondTab.update(() => ({ focusSearchOnOpen: false })),
    ]);
    await settle();
    expect(storage.stored()).toMatchObject({ favourites: ["new-pin"], focusSearchOnOpen: false });
    expect(firstTab.current).toEqual(secondTab.current);
  });

  it("keeps both pins when two tabs pin at once", async () => {
    const storage = fakeStorage({ stored: { favourites: ["a"] } });
    const [firstTab, secondTab] = await Promise.all([SettingsStore.load(), SettingsStore.load()]);
    const pin = (store: SettingsStore, id: string) =>
      store.update((stored) => ({ favourites: toggleFavourite(stored.favourites, id) }));

    await Promise.all([pin(firstTab, "b"), pin(secondTab, "c"), pin(firstTab, "d")]);
    expect(storage.stored()).toMatchObject({ favourites: ["a", "b", "c", "d"] });
  });

  it("doesn't let an older read undo its newer write", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    storage.holdReads();
    storage.writeFromOtherTab({ favourites: ["theirs"] });
    await vi.waitFor(() => {
      expect(storage.heldReads).toHaveLength(1);
    });
    storage.holdReads(false);

    const pinning = settings.update((stored) => ({
      favourites: toggleFavourite(stored.favourites, "mine"),
    }));
    await pinning;
    storage.heldReads[0]?.();
    await settle();
    expect(settings.current.favourites).toEqual(["theirs", "mine"]);
  });

  it("keeps what is stored when a write fails, and a later write doesn't save the failed change", async () => {
    const storage = fakeStorage({ stored: { favourites: ["saved"] } });
    const settings = await SettingsStore.load();

    storage.failNextWrite();
    await expect(settings.update(() => ({ favourites: ["saved", "lost"] }))).rejects.toThrow(
      "quota exceeded",
    );
    expect(settings.current.favourites).toEqual(["saved"]);

    await settings.update(() => ({ home: HOME_WITHOUT_FREQUENT }));
    expect(storage.stored()).toMatchObject({ favourites: ["saved"], home: HOME_WITHOUT_FREQUENT });
  });

  it("validates what it writes", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    const label = { id: "l", text: "  Work  ", color: "blue", privateNetwork: false } as const;

    await settings.update(() => ({ labels: [{ ...label, hosts: [" JIRA.Acme.com "] }] }));
    expect(storage.stored()).toMatchObject({
      labels: [{ ...label, text: "Work", hosts: ["jira.acme.com"] }],
    });
  });
  it("starts writing at once when the page is closing, on top of the settings it holds", async () => {
    const storage = fakeStorage({ stored: { ...DEFAULT_SETTINGS, favourites: ["saved"] } });
    const settings = await SettingsStore.load();

    settings.saveNow((current) => ({ home: { ...current.home, showFrequent: false } }));
    expect(storage.writes).toEqual([
      expect.objectContaining({ favourites: ["saved"], home: HOME_WITHOUT_FREQUENT }),
    ]);
  });

  it("reads the stored settings again when asked, and says when it can't", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeStorage({ failedReads: 2, stored: { ...DEFAULT_SETTINGS, favourites: ["saved"] } });
    const settings = await SettingsStore.load();

    await expect(settings.read()).rejects.toThrow("unavailable");
    expect(settings.loadFailed).toBe(true);
    await settings.read();
    expect(settings.loadFailed).toBe(false);
    expect(settings.current.favourites).toEqual(["saved"]);
  });

  it("doesn't report a saved change as failed when a page can't show it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    settings.subscribe(() => {
      throw new Error("render failed");
    });

    await settings.update(() => ({ favourites: ["a"] }));
    expect(storage.stored()).toMatchObject({ favourites: ["a"] });
    expect(warn).toHaveBeenCalledWith(
      "Overlook: could not show the changed settings",
      expect.objectContaining({ message: "render failed" }),
    );
  });

  it("finishes the work after a write before another tab can write", async () => {
    const storage = fakeStorage();
    const [firstTab, secondTab] = await Promise.all([SettingsStore.load(), SettingsStore.load()]);
    const seenAfterSave: unknown[] = [];

    await Promise.all([
      firstTab.update(
        () => ({ favourites: ["a"] }),
        async () => {
          await settle();
          seenAfterSave.push(storage.stored());
        },
      ),
      secondTab.update(() => ({ favourites: ["b"] })),
    ]);
    expect(seenAfterSave).toEqual([expect.objectContaining({ favourites: ["a"] })]);
    expect(storage.stored()).toMatchObject({ favourites: ["b"] });
  });
});
