import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "../../../src/bookmarks/library";
import type { LabelRule } from "../../../src/settings/settings";
import { SettingsStore } from "../../../src/settings/settings-store";
import type { WallpaperManifest } from "../../../src/wallpaper/schedule";
import { folderNamed } from "../fixtures/sample-library";
import { mergeLabels, SettingsDialog, type SettingsContext } from "../../../src/ui/settings-dialog";

const images = vi.hoisted(() => ({
  saved: new Map<number, Blob>(),
  prepare: vi.fn((file: Blob) => Promise.resolve(file)),
  save: vi.fn((image: Blob, savedAt: number) => {
    images.saved.set(savedAt, image);
    return Promise.resolve();
  }),
  prune: vi.fn<(keepSavedAt: number) => Promise<void>>(() => Promise.resolve()),
}));
const wallpaper = vi.hoisted((): { current: WallpaperManifest | null } => ({ current: null }));

vi.mock("../../../src/backgrounds/custom-background", () => ({
  readCustomBackground: (savedAt: number) => Promise.resolve(images.saved.get(savedAt) ?? null),
  latestCustomBackground: () => {
    const savedAt = Math.max(...images.saved.keys());
    const image = images.saved.get(savedAt);
    return Promise.resolve(image ? { savedAt, image } : null);
  },
  prepareCustomBackground: images.prepare,
  saveCustomBackground: images.save,
  pruneCustomBackgrounds: images.prune,
}));
vi.mock("../../../src/wallpaper/dynamic-wallpaper", () => ({
  loadDynamicWallpaper: () => Promise.resolve(wallpaper.current),
  currentFrame: () => ({ src: "frame.jpg" }),
  watchDynamicWallpaper: () => undefined,
}));

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function stubStorage(initial: unknown, { failedReads = 0 } = {}) {
  let stored = initial;
  let readsToFail = failedReads;
  let writesFail = false;
  const listeners: StorageListener[] = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: () => {
          if (readsToFail === 0) return Promise.resolve({ settings: stored });
          readsToFail--;
          return Promise.reject(new Error("unavailable"));
        },
        set: (items: Record<string, unknown>) => {
          if (writesFail) return Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
          stored = items.settings;
          for (const listener of listeners) listener({ settings: { newValue: stored } }, "local");
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (listener: StorageListener) => {
          listeners.push(listener);
        },
      },
    },
  });
  const changeInAnotherTab = (settings: unknown) => {
    stored = settings;
    for (const listener of listeners) listener({ settings: { newValue: settings } }, "local");
  };
  const failWrites = (fail = true) => {
    writesFail = fail;
  };
  return { stored: () => stored, changeInAnotherTab, failWrites };
}

async function openSettings(
  context: Partial<SettingsContext> = {},
  storedSettings?: unknown,
  storageOptions?: { failedReads: number },
) {
  const storage = stubStorage(storedSettings, storageOptions);
  const store = await SettingsStore.load();
  const settings = new SettingsDialog(store, {
    folders: () => [],
    siteCounts: () => ({ cached: 0, total: 0 }),
    redownload: () => undefined,
    ...context,
  });
  await settings.open();
  const dialog = document.querySelector("dialog");
  if (!dialog) throw new Error("No settings dialog");
  return { store, dialog, settings, ...storage };
}

// happy-dom's :checked matches the checked attribute, not the radio's current state.
const homeSource = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll<HTMLInputElement>("input[name=home-source]")].find(
    (radio) => radio.checked,
  )?.value;

const press = (target: Element) => {
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
};

const filePickerOpens = (dialog: HTMLDialogElement) => {
  const opens: Event[] = [];
  dialog.addEventListener("click", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "file") {
      opens.push(event);
      event.preventDefault();
    }
  });
  return opens;
};

const WORK_LABEL = {
  id: "work",
  text: "Work",
  color: "blue",
  privateNetwork: false,
  hosts: ["jira.example.com"],
};

function upload(dialog: HTMLDialogElement, file: File) {
  const input = dialog.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) throw new Error("No file input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
}

const openAfterFailedLoad = () =>
  openSettings({}, { labels: [WORK_LABEL], home: { source: "frequent" } }, { failedReads: 1 });

const labelNames = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll(".label-row .chip")].map((chip) => chip.textContent);

const sectionNamed = (dialog: HTMLDialogElement, heading: string) => {
  const found = [...dialog.querySelectorAll(".settings__section")].find(
    (candidate) => candidate.querySelector("h3")?.textContent === heading,
  );
  if (!found) throw new Error(`No ${heading} section`);
  return found;
};

const errors = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll(".settings__error")].map((line) => line.textContent);

const radio = (dialog: HTMLDialogElement, source: string) => {
  const found = dialog.querySelector<HTMLInputElement>(`input[name=home-source][value=${source}]`);
  if (!found) throw new Error(`No ${source} radio`);
  return found;
};

const focusSearchBox = (dialog: HTMLDialogElement) => {
  const found = sectionNamed(dialog, "Home").querySelector<HTMLInputElement>(
    "[aria-describedby=focus-search-detail]",
  );
  if (!found) throw new Error("No focus checkbox");
  return found;
};

const tile = (dialog: HTMLDialogElement, key: string) => {
  const found = dialog.querySelector<HTMLButtonElement>(`[data-background="${key}"]`);
  if (!found) throw new Error(`No ${key} tile`);
  return found;
};

const OFFICE: LabelRule = {
  id: "office",
  text: "Office",
  color: "red",
  privateNetwork: false,
  hosts: ["intra.example.com"],
};

const addLabel = (dialog: HTMLDialogElement) => {
  [...dialog.querySelectorAll<HTMLButtonElement>(".settings__action")]
    .find((action) => action.textContent === "New label")
    ?.click();
  window.dispatchEvent(new Event("pagehide"));
};

const describedText = (control: Element | null) =>
  document.getElementById(control?.getAttribute("aria-describedby") ?? "")?.textContent;

beforeEach(() => {
  document.body.replaceChildren();
  images.saved.clear();
  wallpaper.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsDialog", () => {
  it("keeps keyboard focus on the background tile that was chosen", async () => {
    const { store, dialog } = await openSettings();
    const stillLake = () =>
      dialog.querySelector<HTMLButtonElement>('[data-background="photo:still-lake"]');
    stillLake()?.focus();
    stillLake()?.click();

    await vi.waitFor(() => {
      expect(stillLake()?.getAttribute("aria-pressed")).toBe("true");
    });
    expect(store.current.background).toEqual({ kind: "photo", photo: "still-lake" });
    expect(document.activeElement).toBe(stillLake());
  });

  it("uses a saved image again without opening the file picker, and replaces it once chosen", async () => {
    images.saved.set(5, new Blob(["image"], { type: "image/png" }));
    const { store, dialog } = await openSettings();
    const opens = filePickerOpens(dialog);
    const yourImage = () => dialog.querySelector<HTMLButtonElement>('[data-background="custom"]');
    const caption = () => yourImage()?.querySelector(".background-tile__caption")?.textContent;
    expect(yourImage()?.getAttribute("aria-pressed")).toBe("false");
    expect(caption()).toBe("Click to use");

    yourImage()?.click();
    await vi.waitFor(() => {
      expect(yourImage()?.getAttribute("aria-pressed")).toBe("true");
    });
    expect(store.current.background).toEqual({ kind: "custom", savedAt: 5 });
    expect(caption()).toBe("Click to replace");
    expect(opens).toHaveLength(0);

    yourImage()?.click();
    expect(opens).toHaveLength(1);
  });

  it("offers the image tile as an upload, not a toggle, while no image is saved", async () => {
    const { dialog } = await openSettings();
    const opens = filePickerOpens(dialog);
    const yourImage = dialog.querySelector<HTMLButtonElement>('[data-background="custom"]');
    expect(yourImage?.hasAttribute("aria-pressed")).toBe(false);
    expect(yourImage?.querySelector(".background-tile__caption")?.textContent).toBe(
      "Upload a photo",
    );
    expect(
      yourImage?.querySelector(".background-tile__placeholder")?.getAttribute("aria-hidden"),
    ).toBe("true");

    yourImage?.click();
    expect(opens).toHaveLength(1);
  });

  it("keeps focus on 'Download icons again', starts one download and offers it again later", async () => {
    const redownload = vi.fn();
    const { dialog } = await openSettings({ redownload });
    const button = [...dialog.querySelectorAll<HTMLButtonElement>(".settings__action")].find(
      (action) => action.textContent === "Download icons again",
    );
    vi.useFakeTimers();
    button?.focus();
    button?.click();
    button?.click();

    expect(redownload).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.textContent).toBe("Download requested");
    const status = sectionNamed(dialog, "Site icons").querySelectorAll("[role=status]");
    expect([...status].map((line) => line.textContent)).toEqual(["Download requested."]);

    vi.advanceTimersByTime(10_000);
    expect(button?.hasAttribute("aria-disabled")).toBe(false);
    expect(status[0]?.textContent).toBe("");
    button?.click();
    expect(redownload).toHaveBeenCalledTimes(2);
  });

  it("updates the icon count while it is open, counting the sites once, without announcing it", async () => {
    let cached = 1;
    const siteCounts = vi.fn(() => ({ cached, total: 3 }));
    const { dialog, settings } = await openSettings({ siteCounts });
    const count = sectionNamed(dialog, "Site icons").querySelector(".settings__description span");
    expect(count?.textContent).toBe("Sharp icons are saved on this device for 1 of 3 sites.");
    expect(count?.closest("[role=status], [aria-live]")).toBeNull();
    const changes: MutationRecord[] = [];
    new MutationObserver((records) => changes.push(...records)).observe(count ?? document, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    siteCounts.mockClear();
    settings.refreshIcons();
    expect(siteCounts).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(changes).toEqual([]);
    cached = 2;
    settings.refreshIcons();
    expect(count?.textContent).toBe("Sharp icons are saved on this device for 2 of 3 sites.");
  });

  it("keeps a Home choice that is still being saved when icons or bookmarks change", async () => {
    const { dialog, settings } = await openSettings();
    radio(dialog, "frequent").click();
    settings.refreshIcons();
    settings.refresh();
    expect(homeSource(dialog)).toBe("frequent");
  });

  it.each([
    [1, 1, "for 1 of 1 site."],
    [2, 5, "for 2 of 5 sites."],
  ])("counts %i of %i sites with icons in the right number", async (cached, total, text) => {
    const { dialog } = await openSettings({ siteCounts: () => ({ cached, total }) });
    const iconsSection = [...dialog.querySelectorAll(".settings__section")].find(
      (candidate) => candidate.querySelector("h3")?.textContent === "Site icons",
    );
    expect(iconsSection?.querySelector(".settings__description")?.textContent).toContain(text);
  });

  it("names Home's controls by their titles and describes them with the detail text", async () => {
    const { dialog } = await openSettings();
    const cursor = [...dialog.querySelectorAll(".settings__check")].find((check) =>
      check.textContent.startsWith("Put the cursor"),
    );
    expect(cursor?.textContent).toBe("Put the cursor in Overlook's search when a new tab opens");
    expect(describedText(cursor?.querySelector("input") ?? null)).toMatch(
      /^Browsers give a new tab's cursor/,
    );

    const favourites = dialog.querySelector("input[type=radio][value=favourites]");
    const titleId = favourites?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toBe("Favourites");
    expect(describedText(favourites)).toBe("Bookmarks you pin with ☆, in your order.");
  });

  it("closes on a click on the backdrop, but not when a text selection ends there", async () => {
    const { dialog } = await openSettings();
    const control = dialog.querySelector("select");
    if (!control) throw new Error("No control inside the dialog");

    press(control);
    dialog.click();
    expect(dialog.open).toBe(true);

    press(dialog);
    dialog.click();
    expect(dialog.open).toBe(false);
  });

  it("returns focus to the Settings button when the element it came from was re-rendered", async () => {
    const card = document.createElement("button");
    document.body.append(card);
    card.focus();
    const { dialog } = await openSettings();
    card.remove();

    dialog.close();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Settings");
  });

  it("stays open when the second click of the double-click that opened it hits the backdrop", async () => {
    const { dialog } = await openSettings();
    press(dialog);
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(dialog.open).toBe(true);
  });

  it("shows labels another tab changed while it is open, so a label saved here keeps them", async () => {
    const office = { ...WORK_LABEL, id: "office", text: "Office" };
    const { dialog, stored, changeInAnotherTab } = await openSettings({}, { labels: [WORK_LABEL] });
    changeInAnotherTab({ labels: [WORK_LABEL, office] });
    await vi.waitFor(() => {
      expect(labelNames(dialog)).toEqual(["Work", "Office"]);
    });

    addLabel(dialog);
    await vi.waitFor(() => {
      expect(stored()).toMatchObject({ labels: [WORK_LABEL, office, { text: "Label" }] });
    });
  });

  it("keeps the hidden file input out of the tab order and the accessibility tree", async () => {
    const { dialog } = await openSettings();
    const fileInput = dialog.querySelector("input[type=file]");
    expect(fileInput?.getAttribute("tabindex")).toBe("-1");
    expect(fileInput?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    ["the chosen folder", folderNamed("Work").id, "folder"],
    ["Favourites, as Home does, once the chosen folder is deleted", "deleted", "favourites"],
  ])("shows %s as Home's source", async (_, folderId, shown) => {
    const { dialog } = await openSettings(
      { folders: () => [folderNamed("Work")] },
      { home: { source: "folder", folderId, showFrequent: true } },
    );
    expect(homeSource(dialog)).toBe(shown);
    expect(dialog.querySelector("select")?.disabled).toBe(shown !== "folder");
  });

  it("starts saving a label edit before the page is gone when it is closed during the save delay", async () => {
    const { dialog, stored } = await openSettings();
    const set = vi.spyOn(chrome.storage.local, "set");
    dialog.querySelector<HTMLButtonElement>(".label-row__toggle")?.click();
    const name = dialog.querySelector<HTMLInputElement>(".label-editor__name");
    if (!name) throw new Error("No label name field");
    name.value = "Office";
    name.dispatchEvent(new Event("input"));
    expect(set).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pagehide"));
    expect(set).toHaveBeenCalledOnce();
    expect(stored()).toMatchObject({ labels: [{ text: "Office" }] });
  });

  it("still saves a label edit waiting for another tab's lock when the page goes", async () => {
    const { dialog, stored } = await openSettings();
    const { promise: otherTabDone, resolve: releaseLock } = Promise.withResolvers<undefined>();
    void navigator.locks.request("overlook-settings", () => otherTabDone);
    vi.useFakeTimers();
    dialog.querySelector<HTMLButtonElement>(".label-row__toggle")?.click();
    const name = dialog.querySelector<HTMLInputElement>(".label-editor__name");
    if (!name) throw new Error("No label name field");
    name.value = "Office";
    name.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);

    window.dispatchEvent(new Event("pagehide"));
    const storedOnPagehide = stored();
    releaseLock(undefined);
    await vi.runAllTimersAsync();
    expect(storedOnPagehide).toMatchObject({ labels: [{ text: "Office" }] });
    expect(stored()).toMatchObject({ labels: [{ text: "Office" }] });
  });

  it("reads the stored settings before showing them when the page couldn't at first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog, stored } = await openAfterFailedLoad();
    expect(labelNames(dialog)).toEqual(["Work"]);
    expect(homeSource(dialog)).toBe("frequent");

    addLabel(dialog);
    focusSearchBox(dialog).click();
    await vi.waitFor(() => {
      expect(stored()).toMatchObject({
        labels: [WORK_LABEL, { text: "Label" }],
        home: { source: "frequent" },
        focusSearchOnOpen: false,
      });
    });
    expect(errors(dialog)).toEqual(["", "", ""]);
  });

  it("keeps the stored addresses of a label edited after the page first couldn't read them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vpn = { ...WORK_LABEL, id: "vpn", text: "VPN", hosts: ["a.acme.com", "b.acme.com"] };
    const { dialog, stored } = await openSettings({}, { labels: [vpn] }, { failedReads: 1 });
    dialog.querySelector<HTMLButtonElement>(".label-row__toggle")?.click();
    const field = dialog.querySelector<HTMLInputElement>(".host-input__field");
    if (!field) throw new Error("No address field");
    field.value = "new.acme.com";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    window.dispatchEvent(new Event("pagehide"));

    expect(stored()).toMatchObject({
      labels: [{ id: "vpn", hosts: ["a.acme.com", "b.acme.com", "new.acme.com"] }],
    });
  });

  it("lets nothing be changed in Home and Labels while the settings can't be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog, stored } = await openSettings({}, { labels: [WORK_LABEL] }, { failedReads: 2 });
    for (const heading of ["Home", "Labels"]) {
      const controls = sectionNamed(dialog, heading).querySelectorAll<HTMLInputElement>(
        "button, input, select",
      );
      expect(controls.length).toBeGreaterThan(0);
      expect([...controls].every((control) => control.disabled)).toBe(true);
    }
    expect(errors(dialog).filter(Boolean)).toEqual([
      "Couldn't read your settings. Reload the tab to change these.",
      "Couldn't read your settings. Reload the tab to change these.",
    ]);
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()).toEqual({ labels: [WORK_LABEL] });
  });

  it("follows Home, focus and background changes made in another tab, keeping focus", async () => {
    const { dialog, changeInAnotherTab } = await openSettings();
    const favourites = radio(dialog, "favourites");
    favourites.focus();
    changeInAnotherTab({
      home: { source: "frequent", folderId: null, showFrequent: true },
      focusSearchOnOpen: false,
      background: { kind: "photo", photo: "golden-haze" },
    });

    await vi.waitFor(() => {
      expect(homeSource(dialog)).toBe("frequent");
    });
    expect(focusSearchBox(dialog).checked).toBe(false);
    expect(tile(dialog, "photo:golden-haze").getAttribute("aria-pressed")).toBe("true");
    expect(tile(dialog, "photo:autumn-forest").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(favourites);
  });

  it("shows the stored Home setting again, with words for people, when saving it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog, failWrites } = await openSettings();
    failWrites();
    radio(dialog, "frequent").click();

    await vi.waitFor(() => {
      expect(errors(dialog)).toContain("Could not save the Home settings.");
    });
    expect(homeSource(dialog)).toBe("favourites");
    expect(warn).toHaveBeenCalledWith(
      "Overlook: could not save the Home settings",
      expect.objectContaining({ message: "QUOTA_BYTES quota exceeded" }),
    );
  });

  it("clears an old error when it opens again, but shows a label save that failed on closing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog, settings, failWrites } = await openSettings();
    failWrites();
    radio(dialog, "frequent").click();
    await vi.waitFor(() => {
      expect(errors(dialog)).toContain("Could not save the Home settings.");
    });
    dialog.close();
    await settings.open();
    expect(errors(dialog)).toEqual(["", "", ""]);

    [...dialog.querySelectorAll<HTMLButtonElement>(".settings__action")]
      .find((action) => action.textContent === "New label")
      ?.click();
    dialog.close();
    await vi.waitFor(async () => {
      await settings.open();
      expect(errors(dialog)).toContain("Could not save the labels.");
    });
  });

  it("keeps an address typed in a label while another tab adds a label", async () => {
    const { dialog, stored, changeInAnotherTab } = await openSettings({}, { labels: [WORK_LABEL] });
    dialog.querySelector<HTMLButtonElement>(".label-row__toggle")?.click();
    const field = dialog.querySelector<HTMLInputElement>(".host-input__field");
    if (!field) throw new Error("No address field");
    field.focus();
    field.value = "typed.example.com";

    changeInAnotherTab({ labels: [WORK_LABEL, OFFICE] });
    await vi.waitFor(() => {
      expect(labelNames(dialog)).toEqual(["Work", "Office"]);
    });
    expect(document.activeElement).toBe(field);
    field.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => {
      expect(stored()).toMatchObject({
        labels: [{ hosts: ["jira.example.com", "typed.example.com"] }, OFFICE],
      });
    });
  });

  it("keeps a label edit waiting to be saved when another tab changes a different label", async () => {
    const { dialog, stored, changeInAnotherTab } = await openSettings(
      {},
      { labels: [WORK_LABEL, OFFICE] },
    );
    dialog.querySelector<HTMLButtonElement>(".label-row__toggle")?.click();
    const name = dialog.querySelector<HTMLInputElement>(".label-editor__name");
    if (!name) throw new Error("No label name field");
    name.focus();
    name.value = "Jobs";
    name.dispatchEvent(new Event("input"));

    changeInAnotherTab({ labels: [WORK_LABEL, { ...OFFICE, text: "HQ" }] });
    await vi.waitFor(() => {
      expect(labelNames(dialog)).toEqual(["Jobs", "HQ"]);
    });
    expect(document.activeElement).toBe(name);
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => {
      expect(stored()).toMatchObject({ labels: [{ text: "Jobs" }, { text: "HQ" }] });
    });
  });

  it("follows bookmark folders that change while it is open", async () => {
    let folders: Folder[] = [folderNamed("Work"), folderNamed("Dashboards")];
    const { dialog, settings } = await openSettings(
      { folders: () => folders },
      { home: { source: "folder", folderId: folderNamed("Dashboards").id, showFrequent: true } },
    );
    const select = dialog.querySelector("select");
    select?.focus();
    expect(homeSource(dialog)).toBe("folder");

    folders = [folderNamed("Work"), folderNamed("Reading")];
    settings.refresh();
    expect([...(select?.options ?? [])].map((option) => option.text)).toEqual(["Work", "Reading"]);
    expect(homeSource(dialog)).toBe("favourites");
    expect(document.activeElement).toBe(select);
  });

  it("saves an upload under its own key before choosing it, then removes the others", async () => {
    const { dialog, stored } = await openSettings();
    const chosenWhen: Record<string, unknown> = {};
    images.save.mockImplementationOnce((image, savedAt) => {
      chosenWhen.saving = stored();
      images.saved.set(savedAt, image);
      return Promise.resolve();
    });
    images.prune.mockImplementationOnce(() => {
      chosenWhen.pruning = stored();
      return Promise.resolve();
    });
    upload(dialog, new File(["image"], "mine.png", { type: "image/png" }));

    await vi.waitFor(() => {
      expect(images.prune).toHaveBeenCalledOnce();
    });
    const [[, savedAt]] = images.save.mock.calls as [[Blob, number]];
    expect(images.prune).toHaveBeenCalledWith(savedAt);
    expect(chosenWhen.saving).toBeUndefined();
    expect(chosenWhen.pruning).toMatchObject({ background: { kind: "custom", savedAt } });
  });

  it("keeps the old background chosen when saving the upload's choice fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog, store, failWrites } = await openSettings();
    failWrites();
    upload(dialog, new File(["image"], "mine.png", { type: "image/png" }));

    await vi.waitFor(() => {
      expect(errors(dialog)).toContain("Could not save the background.");
    });
    expect(store.current.background).toEqual({ kind: "auto" });
    expect(images.prune).not.toHaveBeenCalled();
  });

  it("keeps a photo picked while an upload was still being prepared", async () => {
    const { dialog, store } = await openSettings();
    let finishSaving = () => undefined;
    images.prepare.mockImplementationOnce(
      (file) =>
        new Promise<Blob>((resolve) => {
          finishSaving = () => {
            resolve(file);
          };
        }),
    );
    upload(dialog, new File(["image"], "mine.png", { type: "image/png" }));
    tile(dialog, "photo:still-lake").click();
    await vi.waitFor(() => {
      expect(store.current.background).toEqual({ kind: "photo", photo: "still-lake" });
    });

    finishSaving();
    await vi.waitFor(() => {
      expect(tile(dialog, "custom").querySelector("img")).not.toBeNull();
    });
    expect(store.current.background).toEqual({ kind: "photo", photo: "still-lake" });
    expect(tile(dialog, "custom").querySelector(".background-tile__caption")?.textContent).toBe(
      "Click to use",
    );
  });

  it("leaves the image the settings name when two tabs upload at once", async () => {
    const { dialog, store, stored } = await openSettings();
    const secondTab = new SettingsDialog(await SettingsStore.load(), {
      folders: () => [],
      siteCounts: () => ({ cached: 0, total: 0 }),
      redownload: () => undefined,
    });
    await secondTab.open();
    const secondDialog = document.querySelectorAll("dialog")[1];
    if (!secondDialog) throw new Error("No second dialog");
    const keepOnly = (savedAt: number) => {
      for (const key of images.saved.keys()) if (key !== savedAt) images.saved.delete(key);
    };
    let finishFirstPrune = () => undefined;
    images.prune
      .mockImplementationOnce(
        (savedAt) =>
          new Promise<void>((resolve) => {
            finishFirstPrune = () => {
              keepOnly(savedAt);
              resolve();
            };
          }),
      )
      .mockImplementationOnce((savedAt) => {
        keepOnly(savedAt);
        return Promise.resolve();
      });
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const file = new File(["image"], "mine.png", { type: "image/png" });

    upload(secondDialog, file);
    await vi.waitFor(() => {
      expect(images.prune).toHaveBeenCalledOnce();
    });
    upload(dialog, file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    finishFirstPrune();
    await vi.waitFor(() => {
      expect(images.prune).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [, [lastKept]] = images.prune.mock.calls as [[number], [number]];
    expect(stored()).toMatchObject({ background: { kind: "custom", savedAt: lastKept } });
    expect(store.current.background).toEqual({ kind: "custom", savedAt: lastKept });
    expect([...images.saved.keys()]).toEqual([lastKept]);
  });

  it.each([
    [new Error("Choose an image file."), "Choose an image file."],
    [new DOMException("Internal error", "UnknownError"), "Could not save the image."],
  ])("explains a failed upload (%s) in words for people", async (failure, message) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog } = await openSettings();
    images.prepare.mockRejectedValueOnce(failure);
    upload(dialog, new File(["image"], "mine.png", { type: "image/png" }));
    await vi.waitFor(() => {
      expect(errors(dialog)).toContain(message);
    });
  });

  it.each([
    ["solar", "Follows the sun", /follows the sun/],
    ["time", "Follows the time of day", /changes with the time of day/],
  ] as const)("describes a %s wallpaper by what it follows", async (mode, caption, description) => {
    wallpaper.current =
      mode === "solar"
        ? { mode, schedule: [{ frame: 0, file: "a.jpg", altitude: 0, azimuth: 90 }] }
        : { mode, schedule: [{ frame: 0, file: "a.jpg", dayFraction: 0 }] };
    const { dialog } = await openSettings();
    expect(tile(dialog, "dynamic").querySelector(".background-tile__caption")?.textContent).toBe(
      caption,
    );
    expect(
      sectionNamed(dialog, "Background").querySelector(".settings__description")?.textContent,
    ).toMatch(description);
  });

  it("links to how to add a dynamic wallpaper when there is none", async () => {
    const { dialog } = await openSettings();
    const link = sectionNamed(dialog, "Background").querySelector(".settings__description a");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/henrygrunberg/overlook#dynamic-wallpaper-optional",
    );
  });

  it("puts the Settings button before the page, right after the skip link", async () => {
    const skipLink = document.createElement("a");
    const page = document.createElement("div");
    page.className = "page";
    document.body.append(skipLink, page);
    await openSettings();
    expect(skipLink.nextElementSibling?.getAttribute("aria-label")).toBe("Settings");
  });

  it("releases the saved image's object URL when the dialog closes", async () => {
    images.saved.set(5, new Blob(["image"], { type: "image/png" }));
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { dialog } = await openSettings();
    const shownUrl = dialog.querySelector('[data-background="custom"] img')?.getAttribute("src");

    dialog.close();
    expect(revoke).toHaveBeenCalledWith(shownUrl);
  });
});

describe("mergeLabels", () => {
  const VPN: LabelRule = { ...OFFICE, id: "vpn", text: "VPN" };

  it("keeps what changed here and what changed in storage", () => {
    const base = [WORK_LABEL as LabelRule, OFFICE, VPN];
    const local = [{ ...WORK_LABEL, text: "Jobs" } as LabelRule, VPN, { ...OFFICE, id: "new" }];
    const stored = [
      WORK_LABEL as LabelRule,
      OFFICE,
      { ...VPN, text: "Tunnel" },
      { ...OFFICE, id: "theirs" },
    ];
    expect(mergeLabels(base, local, stored).map((label) => `${label.id}:${label.text}`)).toEqual([
      "work:Jobs",
      "vpn:Tunnel",
      "theirs:Office",
      "new:Office",
    ]);
  });
});
