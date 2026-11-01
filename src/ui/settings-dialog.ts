import {
  latestCustomBackground,
  prepareCustomBackground,
  pruneCustomBackgrounds,
  readCustomBackground,
  saveCustomBackground,
} from "../backgrounds/custom-background";
import { DEFAULT_PHOTO, PHOTOS, photoThumbnailSrc } from "../backgrounds/photos";
import type { Folder } from "../bookmarks/library";
import {
  PHOTO_IDS,
  parseSettings,
  sameBackground,
  type BackgroundChoice,
  type HomeSettings,
  type HomeSource,
  type LabelRule,
  type Settings,
} from "../settings/settings";
import type { SettingsStore } from "../settings/settings-store";
import { warn, warnOnFailure } from "../log";
import {
  currentFrame,
  loadDynamicWallpaper,
  watchDynamicWallpaper,
} from "../wallpaper/dynamic-wallpaper";
import type { WallpaperManifest } from "../wallpaper/schedule";
import { h, type Child } from "./dom";
import { icon } from "./icons";
import { LabelEditor } from "./label-editor";
import { countOf, folderPath } from "./text";

export interface SettingsContext {
  readonly folders: () => readonly Folder[];
  readonly siteCounts: () => { readonly cached: number; readonly total: number };
  readonly redownload: () => void;
}

interface Section {
  readonly element: HTMLElement;
  readonly sync: (settings: Settings) => void;
}

interface HomeSection extends Section {
  readonly refreshFolders: () => void;
}

interface CustomImage {
  readonly savedAt: number;
  readonly url: string;
}

const SAVE_DELAY_MS = 400;
const REDOWNLOAD_AGAIN_AFTER_MS = 10_000;
const WALLPAPER_HELP_URL = "https://github.com/henrygrunberg/overlook#dynamic-wallpaper-optional";

const errorLine = () => h("p", { className: "settings__error", attributes: { role: "alert" } });

const UNREADABLE_MESSAGE = "Couldn't read your settings. Reload the tab to change these.";

function disableControls(element: HTMLElement): void {
  for (const control of element.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button, input, select")) {
    control.disabled = true;
  }
}

function section(
  title: string,
  description: string | readonly Child[],
  content: Node[],
): HTMLElement {
  return h("section", { className: "settings__section" }, [
    h("h3", { className: "settings__heading", text: title }),
    h(
      "p",
      { className: "settings__description" },
      typeof description === "string" ? [description] : description,
    ),
    ...content,
  ]);
}

function backgroundKey(choice: BackgroundChoice): string {
  return choice.kind === "photo" ? `photo:${choice.photo}` : choice.kind;
}

function shownBackground(
  choice: BackgroundChoice,
  hasDynamic: boolean,
  custom: CustomImage | null,
): BackgroundChoice {
  const defaultPhoto: BackgroundChoice = { kind: "photo", photo: DEFAULT_PHOTO };
  if (choice.kind === "auto" || choice.kind === "dynamic") {
    return hasDynamic ? { kind: "dynamic" } : defaultPhoto;
  }
  if (choice.kind === "custom" && choice.savedAt !== custom?.savedAt) return defaultPhoto;
  return choice;
}

function backgroundDescription(dynamic: WallpaperManifest | null): string | readonly Child[] {
  if (dynamic?.mode === "solar") {
    return (
      "Your dynamic wallpaper follows the sun where you are, worked out from your time zone. " +
      "Or pick a photo, or upload your own."
    );
  }
  if (dynamic) {
    return "Your dynamic wallpaper changes with the time of day. Or pick a photo, or upload your own.";
  }
  return [
    "Pick a photo or upload your own. You can also add a dynamic wallpaper that follows the sun: ",
    h("a", {
      text: "how to add one",
      attributes: { href: WALLPAPER_HELP_URL, target: "_blank", rel: "noreferrer" },
    }),
    ".",
  ];
}

// The image's own problems are explained in words written for people; storage errors
// (DOMExceptions from IndexedDB) only go to the console.
const imageErrorMessage = (reason: unknown) =>
  reason instanceof Error && !(reason instanceof DOMException)
    ? reason.message
    : "Could not save the image.";

// Labels typed here are saved as typed and normalised when read back, so compare normalised.
const normalised = (label: LabelRule) => JSON.stringify(parseSettings({ labels: [label] }).labels);

/**
 * Three-way merge of the labels edited here (`local`, built on `base`) with what storage holds
 * now: a label changed or deleted here keeps that change, every other label follows storage.
 */
export function mergeLabels(
  base: readonly LabelRule[],
  local: readonly LabelRule[],
  stored: readonly LabelRule[],
): LabelRule[] {
  const byId = (labels: readonly LabelRule[]) => new Map(labels.map((label) => [label.id, label]));
  const baseById = byId(base);
  const localById = byId(local);
  const storedIds = new Set(stored.map((label) => label.id));
  const merged = stored.flatMap((label) => {
    const before = baseById.get(label.id);
    const mine = localById.get(label.id);
    if (!mine) return before ? [] : [label];
    const changedHere = !before || normalised(mine) !== normalised(before);
    return [changedHere || normalised(mine) === normalised(label) ? mine : label];
  });
  const added = local.filter((label) => !baseById.has(label.id) && !storedIds.has(label.id));
  return [...merged, ...added];
}

function shownHomeSource(home: HomeSettings, folders: readonly Folder[]): HomeSource {
  const folderExists = folders.some((folder) => folder.id === home.folderId);
  return home.source === "folder" && !folderExists ? "favourites" : home.source;
}

export class SettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly body: HTMLElement;
  private readonly homeError = errorLine();
  private readonly labelsError = errorLine();
  private background: Section | undefined;
  private home: HomeSection | undefined;
  private labels: Section | undefined;
  private icons: Section | undefined;
  private labelEditor: LabelEditor | undefined;
  private labelBase: readonly LabelRule[] = [];
  private saveTimer: number | undefined;
  private labelsSaving: ((stored: Settings) => Partial<Settings>) | undefined;
  private customUrl: string | null = null;
  // Counts background choices, so an upload that finishes after another pick doesn't undo it.
  private backgroundChoices = 0;
  private opener: Element | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly context: SettingsContext,
  ) {
    const button = h(
      "button",
      {
        className: "settings-button glass",
        attributes: { type: "button", "aria-label": "Settings" },
      },
      [icon("settings")],
    );
    this.body = h("div", { className: "settings__body" });
    const close = h(
      "button",
      {
        className: "settings__close",
        attributes: { type: "button", "aria-label": "Close settings" },
      },
      [icon("close")],
    );
    this.dialog = h(
      "dialog",
      { className: "settings glass", attributes: { "aria-labelledby": "settings-title" } },
      [
        h("header", { className: "settings__header" }, [
          h("h2", {
            className: "settings__title",
            text: "Settings",
            attributes: { id: "settings-title" },
          }),
          close,
        ]),
        this.body,
      ],
    );

    button.addEventListener("click", () => void this.open());
    close.addEventListener("click", () => {
      this.dialog.close();
    });
    // Selecting text and releasing over the backdrop also clicks the dialog element itself.
    let pressedBackdrop = false;
    this.dialog.addEventListener("pointerdown", (event) => {
      pressedBackdrop = event.target === this.dialog;
    });
    // The second click of a double-click on the Settings button lands on the backdrop it opened.
    this.dialog.addEventListener("click", (event) => {
      if (pressedBackdrop && event.target === this.dialog && event.detail <= 1) this.dialog.close();
    });
    this.dialog.addEventListener("close", () => {
      // Cleared before the flush, so a label save that fails now is still shown next time.
      this.homeError.textContent = "";
      this.labelsError.textContent = "";
      this.flushLabels();
      this.revokeCustomUrl();
      // A change made here re-renders the page, which may have replaced the element focus was
      // to return to.
      if (this.opener && !this.opener.isConnected) button.focus();
    });
    window.addEventListener("pagehide", () => {
      // A locked save may still be waiting for its lock or read, which the page won't outlive. Any
      // newer edit is written after it.
      if (this.labelsSaving) this.settings.saveNow(this.labelsSaving);
      this.flushLabels(true);
    });
    settings.subscribe((current) => {
      if (this.dialog.open) this.sync(current);
    });
    watchDynamicWallpaper(() => {
      if (this.dialog.open) void this.replaceBackgroundSection();
    });
    // Before the page, so Tab reaches it right after the skip link, as it sits top right.
    document.body.insertBefore(button, document.querySelector(".page"));
    document.body.append(this.dialog);
  }

  async open(): Promise<void> {
    const editable = await this.storedSettingsRead();
    this.background = await this.backgroundSection();
    this.home = this.homeSection(editable);
    this.labels = this.labelsSection(editable);
    this.icons = this.iconsSection();
    this.body.replaceChildren(
      ...[this.background, this.home, this.labels, this.icons].map((part) => part.element),
    );
    if (!this.dialog.open) this.opener = document.activeElement;
    this.dialog.showModal();
  }

  /** Call when the bookmarks change. */
  refresh(): void {
    if (!this.dialog.open) return;
    this.home?.refreshFolders();
    this.icons?.sync(this.settings.current);
  }

  refreshIcons(): void {
    if (this.dialog.open) this.icons?.sync(this.settings.current);
  }

  // Lists like the labels would otherwise be edited on the defaults and replace what is stored.
  private async storedSettingsRead(): Promise<boolean> {
    if (!this.settings.loadFailed) return true;
    try {
      await this.settings.read();
      return true;
    } catch (error: unknown) {
      warn("read your settings", error);
      return false;
    }
  }

  private sync(current: Settings): void {
    for (const part of [this.background, this.home, this.labels]) part?.sync(current);
  }

  private failed(line: HTMLElement, action: string, message: (reason: unknown) => string) {
    return (reason: unknown) => {
      warn(action, reason);
      line.textContent = message(reason);
      this.sync(this.settings.current);
    };
  }

  private revokeCustomUrl(): void {
    if (this.customUrl) URL.revokeObjectURL(this.customUrl);
    this.customUrl = null;
  }

  private async customImage(choice: BackgroundChoice): Promise<CustomImage | null> {
    const found =
      choice.kind === "custom"
        ? await readCustomBackground(choice.savedAt).then((image) =>
            image ? { savedAt: choice.savedAt, image } : null,
          )
        : await latestCustomBackground();
    if (!found) return null;
    this.revokeCustomUrl();
    this.customUrl = URL.createObjectURL(found.image);
    return { savedAt: found.savedAt, url: this.customUrl };
  }

  private async replaceBackgroundSection(): Promise<void> {
    const next = await this.backgroundSection();
    const replaced = this.background?.element;
    if (!replaced?.isConnected) return;
    const focusedKey = (
      replaced.contains(document.activeElement) ? document.activeElement : null
    )?.getAttribute("data-background");
    replaced.replaceWith(next.element);
    this.background = next;
    if (focusedKey) {
      next.element.querySelector<HTMLElement>(`[data-background="${focusedKey}"]`)?.focus();
    }
  }

  private async backgroundSection(): Promise<Section> {
    const { background } = this.settings.current;
    const [dynamic, custom] = await Promise.all([
      loadDynamicWallpaper(),
      this.customImage(background).catch((error: unknown) => {
        warn("read your background image", error);
        return null;
      }),
    ]);
    const error = errorLine();
    const saveFailed = this.failed(
      error,
      "save the background",
      () => "Could not save the background.",
    );
    const fileInput = h("input", {
      className: "visually-hidden",
      attributes: {
        type: "file",
        accept: "image/*",
        "aria-label": "Choose a background image",
        "aria-hidden": "true",
        tabindex: "-1",
      },
    });

    const saveChoice = (choice: BackgroundChoice) => {
      error.textContent = "";
      this.backgroundChoices++;
      this.settings.update(() => ({ background: choice })).catch(saveFailed);
    };
    // Saved, chosen and pruned inside the settings lock, so no tab's prune can remove an image
    // another tab is about to choose. The image gets its own key first, so a failed settings
    // write leaves the old one.
    const upload = async (file: File) => {
      error.textContent = "";
      const choice = ++this.backgroundChoices;
      const savedAt = Date.now();
      let image: Blob;
      try {
        image = await prepareCustomBackground(file);
      } catch (reason: unknown) {
        this.failed(error, "open the background image", imageErrorMessage)(reason);
        return;
      }
      const uploaded: BackgroundChoice = { kind: "custom", savedAt };
      try {
        await this.settings.update(
          async () => {
            await saveCustomBackground(image, savedAt);
            // Picked meanwhile: keep that, and offer the new image as "Your image".
            return choice === this.backgroundChoices ? { background: uploaded } : {};
          },
          async (saved) => {
            if (!sameBackground(saved.background, uploaded)) return;
            await pruneCustomBackgrounds(savedAt).catch(warnOnFailure("remove older backgrounds"));
          },
        );
      } catch (reason: unknown) {
        saveFailed(reason);
        return;
      }
      if (!sameBackground(this.settings.current.background, uploaded)) {
        await this.replaceBackgroundSection();
      }
    };
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) void upload(file);
    });

    const isCustomShown = () =>
      shownBackground(this.settings.current.background, dynamic !== null, custom).kind === "custom";
    const tile = (
      choice: BackgroundChoice,
      name: string,
      caption: HTMLElement | string,
      image: string | null,
    ) =>
      h(
        "button",
        {
          className: "background-tile",
          attributes: { type: "button", "data-background": backgroundKey(choice) },
        },
        [
          image
            ? h("img", { attributes: { src: image, alt: "", loading: "lazy" } })
            : h("span", {
                className: "background-tile__placeholder",
                text: "+",
                attributes: { "aria-hidden": "true" },
              }),
          h("span", { className: "background-tile__name", text: name }),
          typeof caption === "string"
            ? h("span", { className: "background-tile__caption", text: caption })
            : caption,
        ],
      );
    const choices: BackgroundChoice[] = [
      ...(dynamic ? [{ kind: "dynamic" } as const] : []),
      ...PHOTO_IDS.map((photo) => ({ kind: "photo", photo }) as const),
    ];
    const choiceTiles = choices.map((choice) => {
      const button =
        choice.kind === "photo"
          ? tile(
              choice,
              PHOTOS[choice.photo].name,
              `Photo: ${PHOTOS[choice.photo].photographer}`,
              photoThumbnailSrc(choice.photo),
            )
          : tile(
              choice,
              "Dynamic wallpaper",
              dynamic?.mode === "solar" ? "Follows the sun" : "Follows the time of day",
              dynamic && currentFrame(dynamic).src,
            );
      button.addEventListener("click", () => {
        saveChoice(choice);
      });
      return { choice, button };
    });
    const customCaption = h("span", { className: "background-tile__caption" });
    const customTile = tile(
      { kind: "custom", savedAt: 0 },
      "Your image",
      customCaption,
      custom?.url ?? null,
    );
    customTile.addEventListener("click", () => {
      if (!custom || isCustomShown()) fileInput.click();
      else saveChoice({ kind: "custom", savedAt: custom.savedAt });
    });

    const lookedUpSavedAt = background.kind === "custom" ? background.savedAt : custom?.savedAt;
    const sync = (settings: Settings) => {
      const chosen = settings.background;
      if (chosen.kind === "custom" && chosen.savedAt !== lookedUpSavedAt) {
        void this.replaceBackgroundSection();
        return;
      }
      const shown = shownBackground(settings.background, dynamic !== null, custom);
      for (const { choice, button } of choiceTiles) {
        button.setAttribute("aria-pressed", String(sameBackground(choice, shown)));
      }
      const customShown = shown.kind === "custom";
      // Without a saved image the tile only uploads, so it isn't a toggle.
      if (custom) customTile.setAttribute("aria-pressed", String(customShown));
      customCaption.textContent = !custom
        ? "Upload a photo"
        : customShown
          ? "Click to replace"
          : "Click to use";
    };
    sync(this.settings.current);

    return {
      element: section("Background", backgroundDescription(dynamic), [
        h("div", { className: "background-grid" }, [
          ...choiceTiles.map(({ button }) => button),
          customTile,
        ]),
        fileInput,
        error,
      ]),
      sync,
    };
  }

  private homeSection(editable: boolean): HomeSection {
    const failed = this.failed(
      this.homeError,
      "save the Home settings",
      () => "Could not save the Home settings.",
    );
    const save = (change: (stored: Settings) => Partial<Settings>) => {
      this.homeError.textContent = "";
      this.settings.update(change).catch(failed);
    };
    const saveHome = (changes: Partial<HomeSettings>) => {
      save((stored) => ({ home: { ...stored.home, ...changes } }));
    };

    const folderSelect = h("select", {
      className: "settings__select",
      attributes: { "aria-label": "Folder to show on Home" },
    });
    const showFrequent = h("input", { attributes: { type: "checkbox" } });
    const radios = new Map<HomeSource, HTMLInputElement>();
    const option = (source: HomeSource, title: string, detail: string, extra?: Node) => {
      const titleId = `home-source-${source}-title`;
      const detailId = `home-source-${source}-detail`;
      const radio = h("input", {
        attributes: {
          type: "radio",
          name: "home-source",
          value: source,
          "aria-labelledby": titleId,
          "aria-describedby": detailId,
        },
      });
      radios.set(source, radio);
      radio.addEventListener("change", () => {
        enableFor(source);
        saveHome(
          source === "folder" ? { source, folderId: folderSelect.value || null } : { source },
        );
      });
      // The extra control sits beside the radio's label, not inside it: labels can't nest.
      return h("div", { className: "settings__choice" }, [
        h("label", { className: "settings__choice-label" }, [
          radio,
          h("span", { className: "settings__choice-text" }, [
            h("span", {
              className: "settings__choice-title",
              text: title,
              attributes: { id: titleId },
            }),
            h("span", {
              className: "settings__choice-detail",
              text: detail,
              attributes: { id: detailId },
            }),
          ]),
        ]),
        extra && h("div", { className: "settings__choice-extra" }, [extra]),
      ]);
    };
    folderSelect.addEventListener("change", () => {
      saveHome({ folderId: folderSelect.value });
    });
    showFrequent.addEventListener("change", () => {
      saveHome({ showFrequent: showFrequent.checked });
    });

    const focusSearchDetailId = "focus-search-detail";
    const focusSearch = h("input", {
      attributes: { type: "checkbox", "aria-describedby": focusSearchDetailId },
    });
    focusSearch.addEventListener("change", () => {
      const focusSearchOnOpen = focusSearch.checked;
      save(() => ({ focusSearchOnOpen }));
    });

    let folders: readonly Folder[] = [];
    const enableFor = (source: HomeSource) => {
      folderSelect.disabled = !editable || source !== "folder" || folders.length === 0;
      showFrequent.disabled = !editable || source !== "favourites";
    };
    // Updated in place, so a control that has focus keeps it.
    const showFolders = (home: HomeSettings) => {
      const nextFolders = this.context.folders();
      const listed = (list: readonly Folder[]) =>
        list.map((folder) => `${folder.id} ${folderPath(folder.path)}`).join("\n");
      if (listed(nextFolders) !== listed(folders)) {
        folderSelect.replaceChildren(
          ...nextFolders.map((folder) =>
            h("option", { text: folderPath(folder.path), attributes: { value: folder.id } }),
          ),
        );
      }
      folders = nextFolders;
      const chosen = folders.find((folder) => folder.id === home.folderId) ?? folders[0];
      folderSelect.value = chosen?.id ?? "";
      const shownSource = shownHomeSource(home, folders);
      for (const [source, radio] of radios) radio.checked = source === shownSource;
      enableFor(shownSource);
    };
    const sync = ({ home, focusSearchOnOpen }: Settings) => {
      showFolders(home);
      showFrequent.checked = home.showFrequent;
      focusSearch.checked = focusSearchOnOpen;
    };
    // Works from what the controls show: a choice still being saved isn't in the settings yet.
    const refreshFolders = () => {
      const source = [...radios].find(([, radio]) => radio.checked)?.[0] ?? "favourites";
      showFolders({ source, folderId: folderSelect.value, showFrequent: showFrequent.checked });
    };

    const choices = h(
      "div",
      {
        className: "settings__choices",
        attributes: { role: "radiogroup", "aria-label": "What Home shows" },
      },
      [
        option(
          "favourites",
          "Favourites",
          "Bookmarks you pin with ☆, in your order.",
          h("label", { className: "settings__check" }, [
            showFrequent,
            h("span", { text: "Show your most-used links below them" }),
          ]),
        ),
        option("frequent", "Frequent", "Your most-used links, topped up with the newest."),
        option("folder", "A folder", "One of your bookmark folders.", folderSelect),
      ],
    );
    sync(this.settings.current);

    const element = section("Home", "What you see before picking a folder.", [
      choices,
      h("div", { className: "settings__check-group" }, [
        h("label", { className: "settings__check" }, [
          focusSearch,
          h("span", { text: "Put the cursor in Overlook's search when a new tab opens" }),
        ]),
        h("p", {
          className: "settings__choice-detail settings__check-detail",
          text:
            "Browsers give a new tab's cursor to the address bar. Overlook takes it back by " +
            "moving the tab to one of its own pages and straight back as it opens, so the " +
            "address may flash for a moment and the Forward arrow stays lit. If typing still " +
            "lands in the address bar, or you'd rather start there, turn this off.",
          attributes: { id: focusSearchDetailId },
        }),
      ]),
      this.homeError,
    ]);
    if (editable) return { element, sync, refreshFolders };
    disableControls(element);
    this.homeError.textContent = UNREADABLE_MESSAGE;
    return { element, sync: () => undefined, refreshFolders: () => undefined };
  }

  private labelsSection(editable: boolean): Section {
    this.labelBase = this.settings.current.labels;
    const editor = new LabelEditor(this.labelBase, () => {
      // An editor from an earlier opening can still report a field's blur.
      if (editor === this.labelEditor) this.saveLabels();
    });
    this.labelEditor = editor;
    const element = section(
      "Labels",
      "Tag bookmarks by their address, like VPN for sites that only open on the work network.",
      [editor.element, this.labelsError],
    );
    if (!editable) {
      disableControls(element);
      this.labelsError.textContent = UNREADABLE_MESSAGE;
      return { element, sync: () => undefined };
    }
    return {
      element,
      sync: ({ labels }) => {
        editor.show(mergeLabels(this.labelBase, editor.labels, labels));
        this.labelBase = labels;
      },
    };
  }

  private saveLabels(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.flushLabels();
    }, SAVE_DELAY_MS);
  }

  private flushLabels(closingPage = false): void {
    if (this.saveTimer === undefined || !this.labelEditor) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.labelsError.textContent = "";
    const base = this.labelBase;
    const local = [...this.labelEditor.labels];
    const change = (stored: Settings) => ({ labels: mergeLabels(base, local, stored.labels) });
    if (closingPage) {
      this.settings.saveNow(change);
      return;
    }
    this.labelsSaving = change;
    this.settings
      .update(change)
      .catch((reason: unknown) => {
        warn("save labels", reason);
        this.labelsError.textContent = "Could not save the labels.";
        this.labelBase = this.settings.current.labels;
        this.labelEditor?.show(this.labelBase);
      })
      .finally(() => {
        if (this.labelsSaving === change) this.labelsSaving = undefined;
      });
  }

  private iconsSection(): Section {
    // Not a live region: it changes with every icon that arrives.
    const count = h("span");
    const requested = h("span", { className: "visually-hidden", attributes: { role: "status" } });
    const redownload = h("button", {
      className: "settings__action",
      text: "Download icons again",
      attributes: { type: "button" },
    });
    const sync = () => {
      const { cached, total } = this.context.siteCounts();
      const text = `Sharp icons are saved on this device for ${cached} of ${countOf(total, "site")}.`;
      if (count.textContent !== text) count.textContent = text;
    };
    // aria-disabled rather than disabled, so focus stays on the button and its new text is read.
    redownload.addEventListener("click", () => {
      if (redownload.getAttribute("aria-disabled") === "true") return;
      this.context.redownload();
      redownload.setAttribute("aria-disabled", "true");
      redownload.textContent = "Download requested";
      requested.textContent = "Download requested.";
      window.setTimeout(() => {
        redownload.removeAttribute("aria-disabled");
        redownload.textContent = "Download icons again";
        requested.textContent = "";
      }, REDOWNLOAD_AGAIN_AFTER_MS);
    });
    sync();
    return {
      element: section(
        "Site icons",
        [count, " New bookmarks get theirs automatically; sites without a good icon get a letter."],
        [redownload, requested],
      ),
      sync,
    };
  }
}
