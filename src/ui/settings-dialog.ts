import { readCustomBackground, saveCustomBackground } from "../backgrounds/custom-background";
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
import { StandInChangeDroppedError, type SettingsStore } from "../settings/settings-store";
import { warn } from "../log";
import { currentFrame, loadDynamicWallpaper } from "../wallpaper/dynamic-wallpaper";
import { h } from "./dom";
import { icon } from "./icons";
import { LabelEditor } from "./label-editor";
import { countOf } from "./text";

export interface SettingsContext {
  readonly folders: () => readonly Folder[];
  readonly cachedSites: () => number;
  readonly totalSites: () => number;
  readonly redownload: () => void;
}

const SAVE_DELAY_MS = 400;

const errorMessage = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

const errorLine = () => h("p", { className: "settings__error", attributes: { role: "alert" } });

function section(title: string, description: string, content: Node[]): HTMLElement {
  return h("section", { className: "settings__section" }, [
    h("h3", { className: "settings__heading", text: title }),
    h("p", { className: "settings__description", text: description }),
    ...content,
  ]);
}

function backgroundKey(choice: BackgroundChoice): string {
  return choice.kind === "photo" ? `photo:${choice.photo}` : choice.kind;
}

function shownBackground(
  choice: BackgroundChoice,
  hasDynamic: boolean,
  hasCustom: boolean,
): BackgroundChoice {
  const defaultPhoto: BackgroundChoice = { kind: "photo", photo: DEFAULT_PHOTO };
  if (choice.kind === "auto" || choice.kind === "dynamic") {
    return hasDynamic ? { kind: "dynamic" } : defaultPhoto;
  }
  if (choice.kind === "custom" && !hasCustom) return defaultPhoto;
  return choice;
}

// Labels typed here are saved as typed and normalised when read back, so compare normalised.
const sameLabels = (a: readonly LabelRule[], b: readonly LabelRule[]) =>
  JSON.stringify(parseSettings({ labels: a }).labels) ===
  JSON.stringify(parseSettings({ labels: b }).labels);

function shownHomeSource(home: HomeSettings, folders: readonly Folder[]): HomeSource {
  const folderExists = folders.some((folder) => folder.id === home.folderId);
  return home.source === "folder" && !folderExists ? "favourites" : home.source;
}

export class SettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly body: HTMLElement;
  private pendingLabels: readonly LabelRule[] = [];
  private saveTimer: number | undefined;
  private readonly homeError = errorLine();
  private readonly labelsError = errorLine();
  private customUrl: string | null = null;
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
      this.flushLabels();
      this.revokeCustomUrl();
      // A change made here re-renders the page, which may have replaced the element focus was
      // to return to.
      if (this.opener && !this.opener.isConnected) button.focus();
    });
    window.addEventListener("pagehide", () => {
      this.flushLabels();
    });
    // The editor saves its whole list, so labels another tab changed meanwhile must be shown first.
    settings.subscribe((current) => {
      if (!this.dialog.open || this.saveTimer !== undefined) return;
      if (sameLabels(current.labels, this.pendingLabels)) return;
      this.body.children[2]?.replaceWith(this.labelsSection());
    });
    document.body.append(button, this.dialog);
  }

  async open(): Promise<void> {
    this.body.replaceChildren(
      await this.backgroundSection(),
      this.homeSection(),
      this.labelsSection(),
      this.iconsSection(),
    );
    if (!this.dialog.open) this.opener = document.activeElement;
    this.dialog.showModal();
  }

  private revokeCustomUrl(): void {
    if (this.customUrl) URL.revokeObjectURL(this.customUrl);
    this.customUrl = null;
  }

  private async backgroundSection(): Promise<HTMLElement> {
    const [dynamic, custom] = await Promise.all([
      loadDynamicWallpaper(),
      readCustomBackground().catch(() => null),
    ]);
    this.revokeCustomUrl();
    this.customUrl = custom ? URL.createObjectURL(custom) : null;
    const shown = shownBackground(
      this.settings.current.background,
      dynamic !== null,
      custom !== null,
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
    const error = errorLine();
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      saveCustomBackground(file)
        .then(() => this.chooseBackground({ kind: "custom", savedAt: Date.now() }))
        .catch((reason: unknown) => {
          this.showStoredSettingsAfter(reason);
          error.textContent = errorMessage(reason, "Could not save the image.");
        });
    });

    const customShown = shown.kind === "custom";
    const choose = (choice: BackgroundChoice) => {
      if (choice.kind === "custom" && (!custom || customShown)) {
        fileInput.click();
        return;
      }
      const chosen: BackgroundChoice =
        choice.kind === "custom" ? { kind: "custom", savedAt: Date.now() } : choice;
      this.chooseBackground(chosen).catch((reason: unknown) => {
        this.showStoredSettingsAfter(reason);
        error.textContent = errorMessage(reason, "Could not save the background.");
      });
    };

    const tile = (
      choice: BackgroundChoice,
      name: string,
      caption: string,
      image: string | null,
    ) => {
      const pressed = choice.kind === "custom" ? customShown : sameBackground(choice, shown);
      // Without a saved image the tile only uploads, so it isn't a toggle.
      const isUploadOnly = choice.kind === "custom" && !custom;
      const button = h(
        "button",
        {
          className: "background-tile",
          attributes: {
            type: "button",
            "data-background": backgroundKey(choice),
            ...(isUploadOnly ? {} : { "aria-pressed": String(pressed) }),
          },
        },
        [
          image
            ? h("img", { attributes: { src: image, alt: "", loading: "lazy" } })
            : h("span", { className: "background-tile__placeholder", text: "+" }),
          h("span", { className: "background-tile__name", text: name }),
          h("span", { className: "background-tile__caption", text: caption }),
        ],
      );
      button.addEventListener("click", () => {
        choose(choice);
      });
      return button;
    };

    const tiles = [
      dynamic &&
        tile(
          { kind: "dynamic" },
          "Dynamic wallpaper",
          "Follows the sun",
          currentFrame(dynamic).src,
        ),
      ...PHOTO_IDS.map((id) =>
        tile(
          { kind: "photo", photo: id },
          PHOTOS[id].name,
          `Photo: ${PHOTOS[id].photographer}`,
          photoThumbnailSrc(id),
        ),
      ),
      tile(
        { kind: "custom", savedAt: 0 },
        "Your image",
        !custom ? "Upload a photo" : customShown ? "Click to replace" : "Click to use",
        this.customUrl,
      ),
    ];

    return section(
      "Background",
      dynamic
        ? "Your dynamic wallpaper follows the sun where you are, worked out from your time zone. " +
            "Or pick a photo, or upload your own."
        : "Pick a photo or upload your own. You can also add a dynamic wallpaper that follows " +
            "the sun: see the README.",
      [h("div", { className: "background-grid" }, tiles), fileInput, error],
    );
  }

  private async chooseBackground(choice: BackgroundChoice): Promise<void> {
    await this.settings.update({ background: choice });
    const section = await this.backgroundSection();
    const previous = this.body.firstElementChild;
    const hadFocus = previous?.contains(document.activeElement) ?? false;
    previous?.replaceWith(section);
    if (hadFocus) {
      section.querySelector<HTMLElement>(`[data-background="${backgroundKey(choice)}"]`)?.focus();
    }
  }

  private homeSection(): HTMLElement {
    const { home, focusSearchOnOpen } = this.settings.current;
    const folders = this.context.folders();
    const shownSource = shownHomeSource(home, folders);
    const save = (changes: Partial<Settings>) => {
      this.homeError.textContent = "";
      this.settings.update(changes).catch((error: unknown) => {
        warn("save the Home settings", error);
        this.showStoredSettingsAfter(error);
        this.homeError.textContent = errorMessage(error, "Could not save the Home settings.");
      });
    };
    const saveHome = (changes: Partial<HomeSettings>) => {
      save({ home: { ...this.settings.current.home, ...changes } });
    };

    const folderSelect = h(
      "select",
      { className: "settings__select", attributes: { "aria-label": "Folder to show on Home" } },
      folders.map((folder) =>
        h("option", {
          text: folder.path.join(" › "),
          attributes: {
            value: folder.id,
            ...(folder.id === home.folderId ? { selected: "" } : {}),
          },
        }),
      ),
    );
    const showFrequent = h("input", {
      attributes: { type: "checkbox", ...(home.showFrequent ? { checked: "" } : {}) },
    });
    const sync = (source: HomeSource) => {
      folderSelect.disabled = source !== "folder" || folders.length === 0;
      showFrequent.disabled = source !== "favourites";
    };
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
          ...(shownSource === source ? { checked: "" } : {}),
        },
      });
      radio.addEventListener("change", () => {
        sync(source);
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
    sync(shownSource);

    const focusSearchDetailId = "focus-search-detail";
    const focusSearch = h("input", {
      attributes: {
        type: "checkbox",
        "aria-describedby": focusSearchDetailId,
        ...(focusSearchOnOpen ? { checked: "" } : {}),
      },
    });
    focusSearch.addEventListener("change", () => {
      save({ focusSearchOnOpen: focusSearch.checked });
    });

    return section("Home", "What you see before picking a folder.", [
      h(
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
      ),
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
  }

  private labelsSection(): HTMLElement {
    this.pendingLabels = this.settings.current.labels;
    const editor = new LabelEditor(this.pendingLabels, (labels) => {
      this.pendingLabels = [...labels];
      this.saveLabels();
    });
    return section(
      "Labels",
      "Tag bookmarks by their address, like VPN for sites that only open on the work network.",
      [editor.element, this.labelsError],
    );
  }

  private saveLabels(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.flushLabels();
    }, SAVE_DELAY_MS);
  }

  private flushLabels(): void {
    if (this.saveTimer === undefined) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.labelsError.textContent = "";
    this.settings.update({ labels: this.pendingLabels }).catch((error: unknown) => {
      warn("save labels", error);
      this.showStoredSettingsAfter(error);
      this.labelsError.textContent = errorMessage(error, "Could not save the labels.");
    });
  }

  // Home and Labels were built from the stand-in defaults, so another change made through them
  // (or a label save still waiting) would overwrite what storage holds.
  private showStoredSettingsAfter(error: unknown): void {
    if (!(error instanceof StandInChangeDroppedError)) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const [, home, labels] = this.body.children;
    home?.replaceWith(this.homeSection());
    labels?.replaceWith(this.labelsSection());
  }

  private iconsSection(): HTMLElement {
    const status =
      `Sharp icons are saved on this device for ${this.context.cachedSites()} of ` +
      `${countOf(this.context.totalSites(), "site")}. New bookmarks get theirs ` +
      "automatically; sites without a good icon get a letter.";
    const redownload = h("button", {
      className: "settings__action",
      text: "Download icons again",
      attributes: { type: "button" },
    });
    // aria-disabled rather than disabled, so focus stays on the button and its new text is read.
    redownload.addEventListener("click", () => {
      if (redownload.getAttribute("aria-disabled") === "true") return;
      this.context.redownload();
      redownload.setAttribute("aria-disabled", "true");
      redownload.textContent = "Downloading in the background…";
    });
    return section("Site icons", status, [redownload]);
  }
}
