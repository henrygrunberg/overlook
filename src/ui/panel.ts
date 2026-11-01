import type { Bookmark, Folder } from "../bookmarks/library";
import type { HomeSection } from "../home/home-view";
import { h } from "./dom";
import type { FolderColors } from "./folder-colors";
import { icon } from "./icons";
import { linkCard, type BookmarkDecor, type CardDetail } from "./link-card";
import { scrollBehavior } from "./motion";
import { countOf, folderPath } from "./text";

const HIGHLIGHT_MS = 1600;

export type PanelView =
  | {
      readonly kind: "home";
      readonly sections: readonly [HomeSection, ...HomeSection[]];
      readonly editing: boolean;
    }
  | { readonly kind: "folder"; readonly folder: Folder; readonly isHome: boolean };

export interface PanelDecor {
  readonly colorOf: FolderColors;
  readonly decorate: (bookmark: Bookmark) => BookmarkDecor;
}

interface Section {
  readonly id: string;
  readonly heading: string | null;
  readonly bookmarks: readonly Bookmark[];
}

export function folderSections(folder: Folder): Section[] {
  const sections: Section[] = [];
  const visit = (current: Folder) => {
    if (current.bookmarks.length > 0) {
      sections.push({
        id: current.id,
        heading: current === folder ? null : folderPath(current.path.slice(folder.path.length)),
        bookmarks: current.bookmarks,
      });
    }
    current.subfolders.forEach(visit);
  };
  visit(folder);
  return sections;
}

const sectionElementId = (folderId: string) => `section-${folderId}`;

const PANEL_ACTIONS = [
  "toggle-editing",
  "toggle-pin",
  "unpin",
  "move-earlier",
  "move-later",
] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

export function isPanelAction(value: string | undefined): value is PanelAction {
  return PANEL_ACTIONS.some((action) => action === value);
}

function header(leading: Element, title: string, note: string, action?: Node): HTMLElement {
  return h("header", { className: "panel__header" }, [
    leading,
    h("h2", {
      className: "panel__title",
      text: title,
      attributes: { tabindex: "-1", dir: "auto" },
    }),
    h("span", { className: "panel__note", text: note }),
    action,
  ]);
}

function grid(
  bookmarks: readonly Bookmark[],
  detail: CardDetail,
  decor: PanelDecor,
  favourites?: { readonly editing: boolean },
): HTMLElement {
  return h(
    "div",
    { className: "link-grid", attributes: favourites ? { "data-favourites": "" } : {} },
    bookmarks.map((bookmark, index) =>
      linkCard(
        bookmark,
        detail,
        decor.decorate(bookmark),
        favourites?.editing ? { index, count: bookmarks.length } : undefined,
      ),
    ),
  );
}

function emptyState(text: string): HTMLElement {
  return h("p", { className: "panel__empty", text });
}

function editButton(editing: boolean): HTMLButtonElement {
  const action: PanelAction = "toggle-editing";
  return h("button", {
    className: "panel__action",
    text: editing ? "Done" : "Edit",
    attributes: { type: "button", "data-action": action },
  });
}

function renderHome(
  root: HTMLElement,
  view: Extract<PanelView, { kind: "home" }>,
  decor: PanelDecor,
): void {
  const [first, ...rest] = view.sections;
  const isFavourites = first.id === "favourites";
  const body = (section: HomeSection) => {
    if (section.bookmarks.length === 0) return emptyState(section.emptyText);
    const favourites = section.id === "favourites" ? { editing: view.editing } : undefined;
    return grid(section.bookmarks, "path", decor, favourites);
  };

  root.dataset.editing = String(view.editing);
  root.replaceChildren(
    header(
      icon(isFavourites ? "star" : "home", isFavourites ? "icon--filled-star" : ""),
      first.title,
      view.editing ? "Drag to reorder, or use the arrows" : first.note,
      isFavourites && first.bookmarks.length > 0 ? editButton(view.editing) : undefined,
    ),
    h("div", { className: "panel__body" }, [
      body(first),
      ...rest.map((section) =>
        h("section", { className: "panel__section" }, [
          h("h3", { className: "panel__section-title", text: section.title }),
          body(section),
        ]),
      ),
    ]),
  );
}

function focusKey(element: Element | null): string | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  if (element.matches(".panel__title")) return "title";
  if (element.dataset.action !== undefined) {
    return `${element.dataset.action} ${element.dataset.bookmarkId ?? ""}`;
  }
  const cardId = element.closest<HTMLElement>(".link-card-wrap")?.dataset.bookmarkId;
  return element.matches(".link-card") && cardId !== undefined ? `link ${cardId}` : undefined;
}

function focusTarget(root: HTMLElement, key: string): HTMLElement | null {
  const candidates = [
    ...root.querySelectorAll<HTMLElement>(".panel__title, [data-action], .link-card"),
  ];
  const again = candidates.find((candidate) => focusKey(candidate) === key);
  // Moving a card to either end disables the button that moved it, and a full Home disables an
  // unpinned card's star: stay on the same card. When the focused card is gone, fall back to the
  // Edit/Done button, then to the panel's title.
  const sameCard =
    again instanceof HTMLButtonElement && again.disabled
      ? (again.parentElement?.querySelector<HTMLElement>("[data-action]:not(:disabled)") ??
        again.closest(".link-card-wrap")?.querySelector<HTMLElement>(".link-card"))
      : again;
  return (
    sameCard ??
    root.querySelector<HTMLElement>("[data-action=toggle-editing]") ??
    root.querySelector<HTMLElement>(".panel__title")
  );
}

const viewKey = (view: PanelView) => (view.kind === "home" ? "home" : `folder ${view.folder.id}`);

export function renderPanel(root: HTMLElement, view: PanelView, decor: PanelDecor): void {
  const focusedKey = root.contains(document.activeElement)
    ? focusKey(document.activeElement)
    : undefined;
  const sameView = root.dataset.view === viewKey(view);
  const scrollTop = root.querySelector(".panel__body")?.scrollTop ?? 0;

  if (view.kind === "home") renderHome(root, view, decor);
  else renderFolder(root, view, decor);
  root.dataset.view = viewKey(view);
  const body = root.querySelector(".panel__body");
  if (sameView && body) body.scrollTop = scrollTop;

  if (focusedKey === undefined) return;
  const target = focusTarget(root, focusedKey);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "nearest" });
}

function renderFolder(
  root: HTMLElement,
  view: Extract<PanelView, { kind: "folder" }>,
  decor: PanelDecor,
): void {
  const { folder } = view;
  root.dataset.editing = "false";
  const folderIcon = icon("folder");
  folderIcon.style.setProperty("--folder-color", decor.colorOf(folder));
  const sections = folderSections(folder);

  root.replaceChildren(
    header(
      view.isHome ? icon("home") : folderIcon,
      folder.id === folder.topFolderId ? folder.title : folderPath(folder.path),
      countOf(folder.totalBookmarks, "bookmark"),
    ),
    h(
      "div",
      { className: "panel__body" },
      sections.length > 0
        ? sections.map((section) =>
            h(
              "section",
              { className: "panel__section", attributes: { id: sectionElementId(section.id) } },
              [
                section.heading !== null &&
                  h("h3", {
                    className: "panel__section-title",
                    text: section.heading,
                    attributes: { dir: "auto" },
                  }),
                grid(section.bookmarks, "host", decor),
              ],
            ),
          )
        : [emptyState("This folder is empty.")],
    ),
  );
}

function highlightSection(folder: Folder): HTMLElement | null {
  // A folder holding only subfolders has no section of its own: show its first one.
  const target = folderSections(folder)[0];
  const section = target && document.getElementById(sectionElementId(target.id));
  if (!section) return null;
  section.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  section.classList.add("is-highlighted");
  window.setTimeout(() => {
    section.classList.remove("is-highlighted");
  }, HIGHLIGHT_MS);
  return section;
}

export function focusPanelTitle(page: Document): void {
  page.querySelector<HTMLElement>(".panel__title")?.focus({ preventScroll: true });
}

/** Call after rendering the folder's top-level folder. */
export function revealFolder(root: HTMLElement, folder: Folder): void {
  const section = folder.id === folder.topFolderId ? null : highlightSection(folder);
  // Focus inside the revealed section: the next Tab from the title would scroll back to the top.
  const focusTarget =
    section?.querySelector<HTMLElement>(".link-card") ??
    root.querySelector<HTMLElement>(".panel__title");
  focusTarget?.focus({ preventScroll: true });
}
