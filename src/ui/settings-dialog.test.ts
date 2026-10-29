import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../settings/settings-store";
import { folderNamed } from "../test/sample-library";
import { SettingsDialog, type SettingsContext } from "./settings-dialog";

const savedImage: { current: Blob | null } = vi.hoisted(() => ({ current: null }));

vi.mock("../backgrounds/custom-background", () => ({
  readCustomBackground: () => Promise.resolve(savedImage.current),
  saveCustomBackground: () => Promise.resolve(),
}));
vi.mock("../wallpaper/dynamic-wallpaper", () => ({
  loadDynamicWallpaper: () => Promise.resolve(null),
  currentFrame: () => ({ src: "" }),
}));

function stubStorage(initial: unknown, { failedReads = 0 } = {}) {
  let stored = initial;
  let readsToFail = failedReads;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: () => {
          if (readsToFail === 0) return Promise.resolve({ settings: stored });
          readsToFail--;
          return Promise.reject(new Error("unavailable"));
        },
        set: (items: Record<string, unknown>) => {
          stored = items.settings;
          return Promise.resolve();
        },
      },
      onChanged: { addListener: () => undefined },
    },
  });
  return () => stored;
}

async function openSettings(
  context: Partial<SettingsContext> = {},
  storedSettings?: unknown,
  storageOptions?: { failedReads: number },
) {
  const stored = stubStorage(storedSettings, storageOptions);
  const store = await SettingsStore.load();
  const settings = new SettingsDialog(store, {
    folders: () => [],
    cachedSites: () => 0,
    totalSites: () => 0,
    redownload: () => undefined,
    ...context,
  });
  await settings.open();
  const dialog = document.querySelector("dialog");
  if (!dialog) throw new Error("No settings dialog");
  return { store, dialog, stored };
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

const openAfterFailedLoad = () =>
  openSettings({}, { labels: [WORK_LABEL], home: { source: "frequent" } }, { failedReads: 1 });

const labelNames = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll(".label-row .chip")].map((chip) => chip.textContent);

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
  savedImage.current = null;
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
    savedImage.current = new Blob(["image"], { type: "image/png" });
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
    expect(store.current.background.kind).toBe("custom");
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

    yourImage?.click();
    expect(opens).toHaveLength(1);
  });

  it("keeps focus on 'Download icons again' and starts one download", async () => {
    const redownload = vi.fn();
    const { dialog } = await openSettings({ redownload });
    const button = [...dialog.querySelectorAll<HTMLButtonElement>(".settings__action")].find(
      (action) => action.textContent === "Download icons again",
    );
    button?.focus();
    button?.click();
    button?.click();

    expect(redownload).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.textContent).toBe("Downloading in the background…");
  });

  it.each([
    [1, 1, "for 1 of 1 site."],
    [2, 5, "for 2 of 5 sites."],
  ])("counts %i of %i sites with icons in the right number", async (cached, total, text) => {
    const { dialog } = await openSettings({
      cachedSites: () => cached,
      totalSites: () => total,
    });
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

  it("saves a label edit at once when the page is closed during the save delay", async () => {
    const { store, dialog } = await openSettings();
    const update = vi.spyOn(store, "update");
    dialog.querySelector<HTMLButtonElement>(".label-row__toggle")?.click();
    const name = dialog.querySelector<HTMLInputElement>(".label-editor__name");
    if (!name) throw new Error("No label name field");
    name.value = "Office";
    name.dispatchEvent(new Event("input"));
    expect(update).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pagehide"));
    expect(update).toHaveBeenCalledWith({
      labels: [expect.objectContaining({ text: "Office" })],
    });
  });

  it("shows the stored labels after dropping a change made from the defaults, so repeating it keeps them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog, stored } = await openAfterFailedLoad();
    const labelsError = () => dialog.querySelector(".label-editor + .settings__error");
    expect(labelNames(dialog)).toEqual(["VPN"]);

    addLabel(dialog);
    await vi.waitFor(() => {
      expect(labelsError()?.textContent).toMatch(/make the change again/);
    });
    addLabel(dialog);
    await vi.waitFor(() => {
      expect(labelsError()?.textContent).toBe("");
    });
    expect(stored()).toMatchObject({ labels: [WORK_LABEL, { text: "Label" }] });
    expect(labelNames(dialog)).toEqual(["Work", "Label"]);
  });

  it("shows the stored Home settings and the error after dropping a Home change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dialog, stored } = await openAfterFailedLoad();
    expect(homeSource(dialog)).toBe("favourites");

    dialog.querySelector<HTMLInputElement>("input[name=home-source][value=folder]")?.click();
    await vi.waitFor(() => {
      expect(homeSource(dialog)).toBe("frequent");
    });
    const homeSection = dialog.querySelector(".settings__section:has(input[name=home-source])");
    expect(homeSection?.querySelector(".settings__error")?.textContent).toMatch(
      /make the change again/,
    );
    expect(stored()).toMatchObject({ labels: [WORK_LABEL], home: { source: "frequent" } });
  });

  it("drops a label save built from the defaults when a Home change is dropped first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, dialog, stored } = await openAfterFailedLoad();
    const update = vi.spyOn(store, "update");
    [...dialog.querySelectorAll<HTMLButtonElement>(".settings__action")]
      .find((action) => action.textContent === "New label")
      ?.click();

    dialog.querySelector<HTMLInputElement>("input[name=home-source][value=folder]")?.click();
    await vi.waitFor(() => {
      expect(labelNames(dialog)).toEqual(["Work"]);
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(update).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ labels: [WORK_LABEL] });
  });

  it("releases the saved image's object URL when the dialog closes", async () => {
    savedImage.current = new Blob(["image"], { type: "image/png" });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { dialog } = await openSettings();
    const shownUrl = dialog.querySelector('[data-background="custom"] img')?.getAttribute("src");

    dialog.close();
    expect(revoke).toHaveBeenCalledWith(shownUrl);
  });
});
