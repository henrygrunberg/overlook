import type { Bookmark, Folder } from "../bookmarks/library";
import type { SearchResults } from "../search/search-index";
import { h } from "./dom";
import type { FolderColors } from "./folder-colors";
import { icon } from "./icons";
import { faviconTile, labelChips, type BookmarkDecor } from "./link-card";
import { dispositionFor, isRepeatClick, shortcutModifier, type Disposition } from "./navigation";
import { focusPanelTitle } from "./panel";
import { countOf, folderPath } from "./text";

/** `total` counts a folder's bookmarks when the listing stops short of them all. */
export interface SpotlightResults extends SearchResults {
  readonly total?: number | undefined;
}

export interface SpotlightDeps {
  readonly search: (query: string, scopeFolderId: string | undefined) => SpotlightResults;
  readonly colorOf: FolderColors;
  readonly decorate: (bookmark: Bookmark) => BookmarkDecor;
  readonly onOpenFolder: (folder: Folder) => void;
  readonly onOpenBookmark: (bookmark: Bookmark, disposition: Disposition) => void;
  readonly onSearchWeb: (query: string, disposition: Disposition) => void;
}

type Option =
  | { readonly kind: "folder"; readonly folder: Folder }
  | { readonly kind: "bookmark"; readonly bookmark: Bookmark }
  | { readonly kind: "web"; readonly query: string };

const LISTBOX_ID = "spotlight-results";
const SEARCH_ALL_LABEL = "Search bookmarks, folders or the web";
const optionId = (index: number) => `spotlight-option-${index}`;

function keyHint(text: string): HTMLElement {
  return h("kbd", { className: "key-hint", text });
}

function footerHint(keys: string, action: string): HTMLElement {
  return h("span", {}, [keyHint(keys), ` ${action}`]);
}

const topHitIndex = (results: SearchResults) =>
  (results.bookmarks[0]?.score ?? 0) > (results.folders[0]?.score ?? 0)
    ? results.folders.length
    : 0;

function sameOption(a: Option, b: Option): boolean {
  switch (a.kind) {
    case "folder":
      return b.kind === "folder" && a.folder.id === b.folder.id;
    case "bookmark":
      return b.kind === "bookmark" && a.bookmark.id === b.bookmark.id;
    case "web":
      return b.kind === "web";
  }
}

const partialListing = (results: SpotlightResults) =>
  results.total !== undefined && results.total > results.bookmarks.length
    ? `Showing ${results.bookmarks.length} of ${countOf(results.total, "bookmark")}`
    : null;

function resultSummary(results: SpotlightResults): string {
  const partial = partialListing(results);
  if (partial) return partial;
  const counts = [
    [results.folders.length, "folder"],
    [results.bookmarks.length, "bookmark"],
  ] as const;
  const found = counts.filter(([count]) => count > 0).map(([count, noun]) => countOf(count, noun));
  return found.length > 0 ? found.join(", ") : "No bookmarks or folders";
}

function optionGroup(label: string, rows: readonly HTMLElement[]): HTMLElement[] {
  if (rows.length === 0) return [];
  const labelId = `spotlight-group-${label.toLowerCase()}`;
  return [
    h("div", { attributes: { role: "group", "aria-labelledby": labelId } }, [
      h("div", { className: "spotlight__group-label", text: label, attributes: { id: labelId } }),
      ...rows,
    ]),
  ];
}

export class Spotlight {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly scopeChip: HTMLButtonElement;
  private readonly scopeLabel: HTMLElement;
  private readonly scopeSwatch: HTMLElement;
  private readonly popover: HTMLElement;
  private readonly listbox: HTMLElement;
  private readonly note: HTMLElement;
  private readonly escapeAction: HTMLElement;
  private readonly status: HTMLElement;

  private scope: Folder | null = null;
  private options: Option[] = [];
  private activeIndex = 0;
  private picked: Option | null = null;

  constructor(private readonly deps: SpotlightDeps) {
    this.input = h("input", {
      className: "spotlight__input",
      attributes: {
        type: "text",
        role: "combobox",
        "aria-label": SEARCH_ALL_LABEL,
        "aria-autocomplete": "list",
        "aria-expanded": "false",
        "aria-controls": LISTBOX_ID,
        autocomplete: "off",
        spellcheck: "false",
        placeholder: SEARCH_ALL_LABEL,
      },
    });
    this.scopeSwatch = h("span", { className: "spotlight__scope-swatch" });
    this.scopeLabel = h("span", {
      className: "spotlight__scope-label",
      attributes: { dir: "auto" },
    });
    this.scopeChip = h(
      "button",
      {
        className: "spotlight__scope",
        attributes: { type: "button", hidden: "" },
      },
      [this.scopeSwatch, this.scopeLabel, icon("close")],
    );
    this.listbox = h("div", {
      className: "spotlight__listbox",
      attributes: { id: LISTBOX_ID, role: "listbox", "aria-label": "Search results" },
    });
    this.note = h("p", { className: "spotlight__empty", attributes: { hidden: "" } });
    this.escapeAction = h("span", { text: "close" });
    this.status = h("p", { className: "visually-hidden", attributes: { role: "status" } });
    this.popover = h("div", { className: "spotlight__popover", attributes: { hidden: "" } }, [
      this.note,
      this.listbox,
      h("footer", { className: "spotlight__footer", attributes: { "aria-hidden": "true" } }, [
        footerHint("↑↓", "move"),
        footerHint("↵", "open"),
        footerHint(shortcutModifier() === "⌘" ? "⌘↵" : "Ctrl ↵", "background tab"),
        footerHint("⇥", "search in folder"),
        h("span", {}, [keyHint("esc"), " ", this.escapeAction]),
      ]),
    ]);
    this.element = h("div", { className: "spotlight" }, [
      h("div", { className: "spotlight__field" }, [
        icon("search", "spotlight__icon"),
        this.scopeChip,
        this.input,
      ]),
      this.popover,
      this.status,
    ]);

    this.input.addEventListener("input", () => {
      this.update(true);
    });
    this.input.addEventListener("keydown", (event) => {
      this.onKeyDown(event);
    });
    this.input.addEventListener("focus", () => {
      this.update();
    });
    this.input.addEventListener("blur", () => {
      this.setOpen(false);
    });
    this.scopeChip.addEventListener("click", () => {
      this.setScope(null);
      this.input.focus();
    });
    // Keep focus in the input while clicking results, so the popover doesn't close first.
    this.popover.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
  }

  focus(): void {
    this.input.focus();
  }

  refresh(findFolder: (id: string) => Folder | undefined): void {
    if (this.scope) this.setScope(findFolder(this.scope.id) ?? null, false);
    else this.update();
  }

  private get query(): string {
    return this.input.value.trim();
  }

  private setScope(folder: Folder | null, selectTopHit = true): void {
    this.scope = folder;
    this.scopeChip.hidden = folder === null;
    const path = folder ? folderPath(folder.path) : "";
    this.scopeLabel.textContent = path;
    this.scopeChip.title = path;
    this.scopeChip.setAttribute("aria-label", `Remove folder filter ${path}`);
    this.scopeSwatch.style.setProperty("--folder-color", folder ? this.deps.colorOf(folder) : "");
    const inputLabel = folder ? `Search in ${folder.title}` : SEARCH_ALL_LABEL;
    this.input.placeholder = inputLabel;
    this.input.setAttribute("aria-label", inputLabel);
    this.update(selectTopHit);
  }

  private setOpen(open: boolean): void {
    this.popover.hidden = !open;
    this.input.setAttribute("aria-expanded", String(open));
    if (!open) this.input.removeAttribute("aria-activedescendant");
  }

  private update(selectTopHit = false): void {
    const query = this.query;
    const isActive = document.activeElement === this.input;
    if (!isActive || (query === "" && this.scope === null)) {
      this.options = [];
      this.picked = null;
      this.status.textContent = "";
      this.setOpen(false);
      return;
    }

    const results = this.deps.search(query, this.scope?.id);
    this.options = [
      ...results.folders.map((hit): Option => ({ kind: "folder", folder: hit.item })),
      ...results.bookmarks.map((hit): Option => ({ kind: "bookmark", bookmark: hit.item })),
      ...(query === "" ? [] : [{ kind: "web", query } satisfies Option]),
    ];
    if (selectTopHit) this.picked = null;
    // A refresh keeps the option picked with the arrows or the pointer, wherever it moved to.
    const { picked } = this;
    const kept = picked ? this.options.findIndex((option) => sameOption(option, picked)) : -1;
    this.activeIndex = kept >= 0 ? kept : topHitIndex(results);
    // Scrolling to the selected option does nothing while the popover is hidden.
    this.setOpen(true);
    this.renderOptions(results);
  }

  private renderOptions(results: SpotlightResults): void {
    const rows = this.options.map((option, index) => this.optionRow(option, index));
    const foldersEnd = results.folders.length;
    const bookmarksEnd = foldersEnd + results.bookmarks.length;

    const partial = partialListing(results);
    this.note.hidden = bookmarksEnd > 0 && !partial;
    this.note.textContent = partial
      ? `${partial}. Type to narrow them down.`
      : this.scope && this.query === ""
        ? "This folder is empty."
        : "No bookmarks match.";
    this.status.textContent = resultSummary(results);
    this.escapeAction.textContent = this.scope && this.input.value !== "" ? "clear" : "close";
    this.listbox.replaceChildren(
      ...optionGroup("Folders", rows.slice(0, foldersEnd)),
      ...optionGroup("Bookmarks", rows.slice(foldersEnd, bookmarksEnd)),
      ...optionGroup("Web", rows.slice(bookmarksEnd)),
    );
    this.markActive();
  }

  private optionRow(option: Option, index: number): HTMLElement {
    let leading: Element;
    let title: string;
    let detail: Node;
    let hint: string;
    switch (option.kind) {
      case "folder": {
        const folderIcon = icon("folder");
        folderIcon.style.setProperty("--folder-color", this.deps.colorOf(option.folder));
        leading = folderIcon;
        title = option.folder.title;
        const parent = folderPath(option.folder.path.slice(0, -1));
        const count = countOf(option.folder.totalBookmarks, "bookmark");
        detail = h("span", { attributes: { dir: "auto" } }, [
          parent ? `in ${parent} · ${count}` : count,
          h("span", { className: "visually-hidden", text: ", press Tab to search inside" }),
        ]);
        hint = "⇥ search inside  ·  ↵ open";
        break;
      }
      case "bookmark": {
        const decor = this.deps.decorate(option.bookmark);
        leading = faviconTile(option.bookmark, decor, true);
        title = option.bookmark.title;
        detail = h("span", { className: "spotlight__option-meta" }, [
          h("span", {
            className: "spotlight__option-path",
            text: `${folderPath(option.bookmark.path)} · ${option.bookmark.host}`,
            attributes: { dir: "auto" },
          }),
          labelChips(decor.labels),
        ]);
        hint = "↵ open";
        break;
      }
      case "web":
        leading = h("span", { className: "spotlight__web-icon" }, [icon("globe")]);
        title = `Search the web for “${option.query}”`;
        detail = document.createTextNode("Default search engine");
        hint = "↵ search";
        break;
    }

    const row = h(
      "div",
      {
        className: "spotlight__option",
        attributes: {
          id: optionId(index),
          role: "option",
          "aria-selected": "false",
        },
      },
      [
        leading,
        h("span", { className: "spotlight__option-text" }, [
          h("span", {
            className: "spotlight__option-title",
            text: title,
            attributes: { dir: "auto" },
          }),
          h("span", { className: "spotlight__option-detail" }, [detail]),
        ]),
        h("span", {
          className: "spotlight__option-hint",
          text: hint,
          attributes: { "aria-hidden": "true" },
        }),
      ],
    );
    row.addEventListener("pointermove", () => {
      if (this.activeIndex !== index) {
        this.activeIndex = index;
        this.picked = option;
        this.markActive(false);
      }
    });
    row.addEventListener("click", (event) => {
      if (!isRepeatClick(event)) this.activate(index, dispositionFor(event));
    });
    row.addEventListener("auxclick", (event) => {
      if (event.button === 1 && !isRepeatClick(event)) this.activate(index, "background-tab");
    });
    return row;
  }

  // Hovering only highlights: scrolling the list under the pointer would make it jump.
  private markActive(reveal = true): void {
    for (const row of this.listbox.querySelectorAll<HTMLElement>("[role=option]")) {
      const active = row.id === optionId(this.activeIndex);
      row.setAttribute("aria-selected", String(active));
      if (active && reveal) {
        // A group's first option scrolls its heading into view too, as when the list opened.
        const heading = row.previousElementSibling;
        if (heading?.matches(".spotlight__group-label"))
          heading.scrollIntoView({ block: "nearest" });
        row.scrollIntoView({ block: "nearest" });
      }
    }
    if (this.options.length > 0) {
      this.input.setAttribute("aria-activedescendant", optionId(this.activeIndex));
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }
  }

  private activate(index: number, disposition: Disposition): void {
    const option = this.options[index];
    if (!option) return;
    switch (option.kind) {
      case "folder":
        this.reset();
        this.deps.onOpenFolder(option.folder);
        break;
      case "bookmark":
        this.deps.onOpenBookmark(option.bookmark, disposition);
        if (disposition === "current-tab") this.reset();
        break;
      case "web":
        this.deps.onSearchWeb(option.query, disposition);
        if (disposition === "current-tab") this.reset();
        break;
    }
  }

  private reset(): void {
    this.input.value = "";
    this.setScope(null);
    this.input.blur();
  }

  private moveActive(step: number): void {
    if (this.options.length === 0) return;
    this.activeIndex = (this.activeIndex + step + this.options.length) % this.options.length;
    this.picked = this.options[this.activeIndex] ?? null;
    this.markActive();
  }

  // A held key repeats: the arrows keep moving, but opening, entering or leaving a folder happen once.
  private onKeyDown(event: KeyboardEvent): void {
    // While an input method is composing (Japanese, Chinese, …) these keys belong to it.
    if (event.isComposing) return;
    const active = this.options[this.activeIndex];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.moveActive(-1);
        break;
      case "Enter":
        event.preventDefault();
        if (!event.repeat) this.activate(this.activeIndex, dispositionFor(event));
        break;
      case "Tab":
        if (active?.kind === "folder" && !event.shiftKey) {
          event.preventDefault();
          if (event.repeat) break;
          this.input.value = "";
          this.setScope(active.folder);
        }
        break;
      case "Backspace":
        if (this.input.value === "" && this.scope && !event.repeat) {
          event.preventDefault();
          this.setScope(null);
        }
        break;
      case "Escape":
        event.preventDefault();
        if (this.input.value !== "") {
          this.input.value = "";
          this.update(true);
        } else if (this.scope) {
          this.setScope(null);
        } else {
          // Out of the field, so the single-key shortcuts work again, but never onto the page.
          focusPanelTitle(document);
        }
        break;
    }
  }
}
