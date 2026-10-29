import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { SettingsStore } from "./settings-store";

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

interface PendingWrite {
  readonly value: unknown;
  readonly finish: () => void;
  readonly fail: () => void;
}

function fakeStorage({ failedReads = 0 } = {}) {
  let readsToFail = failedReads;
  const listeners: ChangeListener[] = [];
  const writes: PendingWrite[] = [];
  const heldReads: (() => void)[] = [];
  let holdingReads = false;
  let stored: unknown;
  const announce = (value: unknown) => {
    for (const listener of listeners) listener({ settings: { newValue: value } }, "local");
  };
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
        set: (items: Record<string, unknown>) =>
          new Promise<void>((resolve, reject) => {
            writes.push({
              value: items.settings,
              finish: () => {
                stored = items.settings;
                resolve();
              },
              fail: () => {
                reject(new Error("quota exceeded"));
              },
            });
          }),
      },
      onChanged: { addListener: (listener: ChangeListener) => listeners.push(listener) },
    },
  });
  const writeFromOtherTab = (value: unknown) => {
    stored = value;
    announce(value);
  };
  const holdReads = () => {
    holdingReads = true;
  };
  return { writes, heldReads, holdReads, announce, writeFromOtherTab };
}

const HOME_WITHOUT_FREQUENT = { ...DEFAULT_SETTINGS.home, showFrequent: false };

describe("SettingsStore", () => {
  it("falls back to the defaults when storage can't be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeStorage({ failedReads: 1 });
    const settings = await SettingsStore.load();
    expect(settings.current).toEqual(DEFAULT_SETTINGS);
    expect(settings.loadFailed).toBe(true);
  });

  it("drops a change made from the defaults and shows the stored settings instead", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage({ failedReads: 1 });
    storage.writeFromOtherTab({ ...DEFAULT_SETTINGS, favourites: ["saved"] });
    const settings = await SettingsStore.load();
    const heard: unknown[] = [];
    settings.subscribe((current) => heard.push(current.favourites));

    await expect(settings.update({ favourites: ["new"] })).rejects.toThrow("make the change again");
    expect(storage.writes).toEqual([]);
    expect(settings.current.favourites).toEqual(["saved"]);
    expect(settings.loadFailed).toBe(false);
    expect(heard).toEqual([["saved"]]);
  });

  it("drops every change made before the stored settings were read, then saves again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage({ failedReads: 1 });
    storage.writeFromOtherTab({ ...DEFAULT_SETTINGS, home: HOME_WITHOUT_FREQUENT });
    const settings = await SettingsStore.load();
    const heard: unknown[] = [];
    settings.subscribe((current) => heard.push(current.home));

    const results = await Promise.allSettled([
      settings.update({ favourites: ["a"] }),
      settings.update({ focusSearchOnOpen: false }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(storage.writes).toEqual([]);
    expect(heard).toEqual([HOME_WITHOUT_FREQUENT]);

    const pin = settings.update({ favourites: ["a"] });
    expect(storage.writes[0]?.value).toMatchObject({
      home: HOME_WITHOUT_FREQUENT,
      favourites: ["a"],
    });
    storage.writes[0]?.finish();
    await pin;
  });

  it("writes nothing when storage still can't be read after a failed load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage({ failedReads: 2 });
    const settings = await SettingsStore.load();

    await expect(settings.update({ favourites: ["a"] })).rejects.toThrow("unavailable");
    expect(storage.writes).toEqual([]);
    expect(settings.current).toEqual(DEFAULT_SETTINGS);
    expect(settings.loadFailed).toBe(true);
  });

  it("ends the fallback to the defaults when another tab saves settings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = fakeStorage({ failedReads: 1 });
    const settings = await SettingsStore.load();

    storage.writeFromOtherTab({ ...DEFAULT_SETTINGS, favourites: ["x"] });
    expect(settings.loadFailed).toBe(false);
    expect(settings.current.favourites).toEqual(["x"]);
  });

  it("says when the settings came from storage", async () => {
    fakeStorage();
    expect((await SettingsStore.load()).loadFailed).toBe(false);
  });

  it("doesn't let the event of an older write undo a newer one", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();

    const first = settings.update({ favourites: ["a"] });
    const second = settings.update({ favourites: ["a", "b"] });
    storage.writes[0]?.finish();
    await first;
    storage.announce(storage.writes[0]?.value);
    expect(settings.current.favourites).toEqual(["a", "b"]);

    storage.writes[1]?.finish();
    await second;
    storage.announce(storage.writes[1]?.value);
    expect(settings.current.favourites).toEqual(["a", "b"]);
  });

  it("adopts changes made in other tabs", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    const heard: unknown[] = [];
    settings.subscribe((current) => heard.push(current.favourites));

    storage.writeFromOtherTab({ favourites: ["x"] });
    expect(settings.current.favourites).toEqual(["x"]);
    expect(heard).toEqual([["x"]]);
  });

  it("picks up another tab's change that landed while its own write was in flight", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    const heard: unknown[] = [];
    settings.subscribe((current) => heard.push(current.favourites));

    const update = settings.update({ favourites: ["mine"] });
    storage.writes[0]?.finish();
    storage.writeFromOtherTab({ favourites: ["theirs"] });
    expect(settings.current.favourites).toEqual(["mine"]);

    await update;
    expect(settings.current.favourites).toEqual(["theirs"]);
    expect(heard.at(-1)).toEqual(["theirs"]);
  });

  it("keeps another tab's change that arrived while reading back its own write", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();
    storage.holdReads();

    const update = settings.update({ favourites: ["mine"] });
    storage.writes[0]?.finish();
    await vi.waitFor(() => {
      expect(storage.heldReads).toHaveLength(1);
    });
    storage.writeFromOtherTab({ favourites: ["theirs"] });
    storage.heldReads[0]?.();
    await update;

    expect(settings.current.favourites).toEqual(["theirs"]);
  });

  it("goes back to what is stored when a write fails", async () => {
    const storage = fakeStorage();
    storage.writeFromOtherTab({ favourites: ["saved"] });
    const settings = await SettingsStore.load();

    const update = settings.update({ favourites: ["saved", "lost"] });
    storage.writes[0]?.fail();
    await expect(update).rejects.toThrow("quota exceeded");
    expect(settings.current.favourites).toEqual(["saved"]);
  });

  it("keeps a later change that saved when an overlapping earlier write fails", async () => {
    const storage = fakeStorage();
    const settings = await SettingsStore.load();

    const pin = settings.update({ favourites: ["a"] });
    const hideFrequent = settings.update({
      home: { ...DEFAULT_SETTINGS.home, showFrequent: false },
    });
    storage.writes[0]?.fail();
    await expect(pin).rejects.toThrow();
    storage.writes[1]?.finish();
    await hideFrequent;

    expect(settings.current.favourites).toEqual(["a"]);
    expect(settings.current.home.showFrequent).toBe(false);
  });
});
