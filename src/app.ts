import { BackgroundView } from "./backgrounds/background-view";
import {
  buildLibrary,
  type Bookmark,
  type BookmarkNode,
  type Folder,
  type Library,
} from "./bookmarks/library";
import { IconLibrary } from "./favicons/icon-library";
import { homeView } from "./home/home-view";
import { iconOrigin } from "./favicons/icon-store";
import { compileLabels, type LabelsOf } from "./labels/labels";
import { warn, warnOnFailure } from "./log";
import { SearchIndex } from "./search/search-index";
import {
  MAX_FAVOURITES,
  moveFavourite,
  sameBackground,
  toggleFavourite,
  type Settings,
} from "./settings/settings";
import type { SettingsStore } from "./settings/settings-store";
import { mountClock } from "./ui/clock";
import { scrollBehavior } from "./ui/motion";
import { h } from "./ui/dom";
import { folderColors, type FolderColors } from "./ui/folder-colors";
import { refreshIconTiles, type BookmarkDecor } from "./ui/link-card";
import { openUrl, searchWeb, type Disposition } from "./ui/navigation";
import {
  folderSections,
  renderPanel,
  sectionElementId,
  type PanelAction,
  type PanelView,
} from "./ui/panel";
import { bindPanelEvents } from "./ui/panel-events";
import { SettingsDialog } from "./ui/settings-dialog";
import { bindShortcuts } from "./ui/shortcuts";
import { renderSidebar } from "./ui/sidebar";
import { Spotlight } from "./ui/spotlight";
import { UsageStore } from "./usage/usage-store";

const SCOPED_LIMIT = 200;
const REBUILD_DELAY_MS = 150;

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in newtab.html`);
  return element;
}

function withSubfolders(folder: Folder): Folder[] {
  return [folder, ...folder.subfolders.flatMap(withSubfolders)];
}

async function loadUsage(): Promise<UsageStore> {
  try {
    return await UsageStore.load(chrome.storage.local);
  } catch (error: unknown) {
    warn("read usage history; Frequent starts empty", error);
    return UsageStore.inMemory();
  }
}

interface LibraryState {
  readonly library: Library;
  readonly bookmarkById: ReadonlyMap<string, Bookmark>;
  readonly colorOf: FolderColors;
}

function libraryState(tree: readonly BookmarkNode[]): LibraryState {
  const library = buildLibrary(tree);
  return {
    library,
    bookmarkById: new Map(library.bookmarks.map((bookmark) => [bookmark.id, bookmark])),
    colorOf: folderColors(library.topFolders),
  };
}

function searchIndex(library: Library, labelsOf: LabelsOf): SearchIndex {
  return new SearchIndex(library, (bookmark) => labelsOf(bookmark).map((label) => label.text));
}

const labelsKey = (settings: Settings) => JSON.stringify(settings.labels);

export async function startApp(settings: SettingsStore): Promise<void> {
  const background = new BackgroundView(requireElement("wallpaper"));
  let shownBackground = settings.current.background;
  void background.apply(shownBackground);
  mountClock(requireElement("clock"));

  const sidebarRoot = requireElement("sidebar");
  const panelRoot = requireElement("panel");
  const [usage, icons, tree] = await Promise.all([
    loadUsage(),
    IconLibrary.load(),
    chrome.bookmarks.getTree(),
  ]);

  let state = libraryState(tree);
  let labelsOf: LabelsOf = compileLabels(settings.current.labels);
  let indexedLabels = labelsKey(settings.current);
  // Only search needs it, so it's built on first use and dropped when bookmarks or labels change.
  let index: SearchIndex | undefined;
  const currentIndex = () => (index ??= searchIndex(state.library, labelsOf));
  let selectedFolderId: string | null = null;
  let editingFavourites = false;
  let pinnedIds: ReadonlySet<string> = new Set();
  let canPin = false;

  const favouriteBookmarks = () =>
    settings.current.favourites
      .map((id) => state.bookmarkById.get(id))
      .filter((bookmark) => bookmark !== undefined);
  const shownFavourites = () => favouriteBookmarks().map((bookmark) => bookmark.id);
  const decorate = (bookmark: Bookmark): BookmarkDecor => ({
    color: state.colorOf(bookmark),
    labels: labelsOf(bookmark),
    icons,
    pinned: pinnedIds.has(bookmark.id),
    canPin,
  });

  const panelView = (selected: Folder | undefined, favourites: readonly Bookmark[]): PanelView => {
    if (selected) return { kind: "folder", folder: selected, isHome: false };
    const view = homeView(state.library, usage, settings.current.home, favourites);
    if (view.kind === "folder") return { kind: "folder", folder: view.folder, isHome: true };
    const hasFavourites = view.sections.some(
      (section) => section.id === "favourites" && section.bookmarks.length > 0,
    );
    return { kind: "home", sections: view.sections, editing: editingFavourites && hasFavourites };
  };

  const render = () => {
    const favourites = favouriteBookmarks();
    pinnedIds = new Set(favourites.map((bookmark) => bookmark.id));
    canPin = favourites.length < MAX_FAVOURITES;
    const selected = state.library.topFolders.find((folder) => folder.id === selectedFolderId);
    selectedFolderId = selected?.id ?? null;
    renderSidebar(sidebarRoot, {
      folders: state.library.topFolders,
      selectedFolderId,
      colorOf: state.colorOf,
      onSelect: (folderId) => {
        selectedFolderId = folderId;
        render();
      },
    });
    const view = panelView(selected, favourites);
    if (view.kind === "home") editingFavourites = view.editing;
    renderPanel(panelRoot, view, { colorOf: state.colorOf, decorate });
  };

  const saveFavourites = (favourites: readonly string[]) => {
    settings.update({ favourites }).catch(warnOnFailure("save your favourites"));
  };
  const moveFavouriteTo = (id: string, toIndex: number) => {
    saveFavourites(moveFavourite(shownFavourites(), id, toIndex));
  };

  const open = (url: string, disposition: Disposition) => {
    void usage
      .recordVisit(url)
      .catch(warnOnFailure("record the visit"))
      .then(() => openUrl(url, disposition))
      .catch(warnOnFailure(`open ${url}`));
  };

  const highlightSection = (folder: Folder) => {
    // A folder holding only subfolders has no section of its own: show its first one.
    const target = folderSections(folder)[0];
    const section = target && document.getElementById(sectionElementId(target.id));
    if (!section) return null;
    section.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    section.classList.add("is-highlighted");
    window.setTimeout(() => {
      section.classList.remove("is-highlighted");
    }, 1600);
    return section;
  };
  const revealFolder = (folder: Folder) => {
    selectedFolderId = folder.topFolderId;
    render();
    const section = folder.id === folder.topFolderId ? null : highlightSection(folder);
    // Focus inside the revealed section: the next Tab from the title would scroll back to the top.
    const focusTarget =
      section?.querySelector<HTMLElement>(".link-card") ??
      panelRoot.querySelector<HTMLElement>(".panel__title");
    focusTarget?.focus({ preventScroll: true });
  };

  const spotlight = new Spotlight({
    search: (query, scopeFolderId) =>
      currentIndex().search(query, {
        scopeFolderId,
        bookmarkBoost: (bookmark) => usage.boost(bookmark.url),
        ...(scopeFolderId !== undefined && query === ""
          ? { folderLimit: SCOPED_LIMIT, bookmarkLimit: SCOPED_LIMIT }
          : {}),
      }),
    colorOf: (folder) => state.colorOf(folder),
    decorate,
    onOpenFolder: revealFolder,
    onOpenBookmark: (bookmark, disposition) => {
      open(bookmark.url, disposition);
    },
    onSearchWeb: (query, disposition) => {
      searchWeb(query, disposition).catch(warnOnFailure("search the web"));
    },
  });
  requireElement("spotlight-slot").append(spotlight.element);

  const bookmarkUrls = () => state.library.bookmarks.map((bookmark) => bookmark.url);
  const siteOrigins = () =>
    new Set(
      bookmarkUrls()
        .map(iconOrigin)
        .filter((origin) => origin !== null),
    );
  const settingsDialog = new SettingsDialog(settings, {
    folders: () => state.library.topFolders.flatMap(withSubfolders),
    cachedSites: () => [...siteOrigins()].filter((origin) => icons.hasCachedIcon(origin)).length,
    totalSites: () => siteOrigins().size,
    redownload: () => {
      icons.request(bookmarkUrls(), true);
    },
  });

  const findFolder = (id: string) => state.library.folderById.get(id);
  icons.watch((origin) => {
    refreshIconTiles(document, origin, icons, (id) => state.bookmarkById.get(id));
  });
  icons.request(bookmarkUrls());

  const showBackground = (current: Settings) => {
    if (sameBackground(current.background, shownBackground)) return;
    shownBackground = current.background;
    void background.apply(shownBackground);
  };
  settings.subscribe((current) => {
    // Storage events parse into new arrays every time, so compare the labels by value.
    const labelsChanged = labelsKey(current) !== indexedLabels;
    if (labelsChanged) {
      indexedLabels = labelsKey(current);
      labelsOf = compileLabels(current.labels);
      index = undefined;
    }
    render();
    if (labelsChanged) spotlight.refresh(findFolder);
    showBackground(current);
  });
  // Another tab may have changed the background while the bookmarks loaded, before this subscribed.
  showBackground(settings.current);

  const runPanelAction = (action: PanelAction, id: string | undefined) => {
    const position = id === undefined ? -1 : shownFavourites().indexOf(id);
    switch (action) {
      case "toggle-editing":
        editingFavourites = !editingFavourites;
        render();
        break;
      case "toggle-pin":
      case "unpin":
        if (id !== undefined) saveFavourites(toggleFavourite(shownFavourites(), id));
        break;
      case "move-earlier":
        if (id !== undefined && position > 0) moveFavouriteTo(id, position - 1);
        break;
      case "move-later":
        if (id !== undefined && position >= 0) moveFavouriteTo(id, position + 1);
        break;
    }
  };
  bindPanelEvents(panelRoot, {
    open,
    runAction: runPanelAction,
    moveFavourite: (id, ontoId) => {
      const toIndex = shownFavourites().indexOf(ontoId);
      if (toIndex >= 0) moveFavouriteTo(id, toIndex);
    },
  });
  bindShortcuts(document, {
    focusSearch: () => {
      spotlight.focus();
    },
    openSettings: () => {
      void settingsDialog.open();
    },
  });

  let rebuildTimer: number | undefined;
  const rebuild = () => {
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => {
      chrome.bookmarks
        .getTree()
        .then((freshTree) => {
          state = libraryState(freshTree);
          index = undefined;
          render();
          spotlight.refresh(findFolder);
        })
        .catch(warnOnFailure("reload bookmarks"));
    }, REBUILD_DELAY_MS);
  };
  for (const event of [
    chrome.bookmarks.onCreated,
    chrome.bookmarks.onRemoved,
    chrome.bookmarks.onChanged,
    chrome.bookmarks.onMoved,
    chrome.bookmarks.onChildrenReordered,
    chrome.bookmarks.onImportEnded,
  ]) {
    event.addListener(rebuild);
  }

  render();
  if (settings.current.focusSearchOnOpen) spotlight.focus();
}

export function showStartupError(error: unknown): void {
  console.error("Overlook failed to start", error);
  document.getElementById("panel")?.replaceChildren(
    h("p", {
      className: "panel__empty",
      text: "Overlook couldn't load your bookmarks. Reload the tab to try again.",
    }),
  );
}
