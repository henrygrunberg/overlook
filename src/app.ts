import { BackgroundView } from "./ui/background-view";
import {
  buildLibrary,
  type Bookmark,
  type BookmarkNode,
  type Folder,
  type Library,
} from "./bookmarks/library";
import { IconLibrary } from "./favicons/icon-library";
import { homeView } from "./home/home-view";
import { iconOrigins } from "./favicons/icon-store";
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
import { h } from "./ui/dom";
import { folderColors, type FolderColors } from "./ui/folder-colors";
import { refreshIconTiles, type BookmarkDecor } from "./ui/link-card";
import { openUrl, searchWeb, type Disposition } from "./ui/navigation";
import { renderPanel, revealFolder, type PanelAction, type PanelView } from "./ui/panel";
import { bindPanelEvents } from "./ui/panel-events";
import { SettingsDialog } from "./ui/settings-dialog";
import { watchDynamicWallpaper } from "./wallpaper/dynamic-wallpaper";
import { bindShortcuts } from "./ui/shortcuts";
import { renderSidebar } from "./ui/sidebar";
import { Spotlight, type SpotlightResults } from "./ui/spotlight";
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

// Called before the bookmarks are read, so a change made while the page starts isn't missed.
function watchBookmarks(): (onChange: () => void) => void {
  let handler: (() => void) | undefined;
  let changedBeforeHandler = false;
  for (const event of [
    chrome.bookmarks.onCreated,
    chrome.bookmarks.onRemoved,
    chrome.bookmarks.onChanged,
    chrome.bookmarks.onMoved,
    chrome.bookmarks.onChildrenReordered,
    chrome.bookmarks.onImportEnded,
  ]) {
    event.addListener(() => {
      if (handler) handler();
      else changedBeforeHandler = true;
    });
  }
  return (onChange) => {
    handler = onChange;
    if (changedBeforeHandler) onChange();
  };
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

const differ = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

export async function startApp(settings: SettingsStore): Promise<void> {
  const background = new BackgroundView(requireElement("wallpaper"));
  let shownBackground = settings.current.background;
  // Before the first look at the flag, so the worker finding a wallpaper meanwhile isn't missed.
  watchDynamicWallpaper(() => {
    if (shownBackground.kind === "auto" || shownBackground.kind === "dynamic") {
      void background.apply(shownBackground);
    }
  });
  void background.apply(shownBackground);
  mountClock(requireElement("clock"));

  const sidebarRoot = requireElement("sidebar");
  const panelRoot = requireElement("panel");
  const announcer = requireElement("announcer");
  const onBookmarksChanged = watchBookmarks();
  const [usage, icons, tree] = await Promise.all([
    UsageStore.load(chrome.storage.local),
    IconLibrary.load(),
    chrome.bookmarks.getTree(),
  ]);

  let state = libraryState(tree);
  let labelsOf: LabelsOf = compileLabels(settings.current.labels);
  // Only search needs it, so it's built on first use and dropped when bookmarks or labels change.
  let index: SearchIndex | undefined;
  const currentIndex = () => (index ??= searchIndex(state.library, labelsOf));
  let selectedFolderId: string | null = null;
  // An empty subfolder opened from search has no section in its top folder to show it by.
  let emptySubfolderId: string | null = null;
  let editingFavourites = false;
  let homeShowsFrequent = false;
  let pinnedIds: ReadonlySet<string> = new Set();
  let canPin = false;

  const favouriteBookmarks = () =>
    settings.current.favourites
      .map((id) => state.bookmarkById.get(id))
      .filter((bookmark) => bookmark !== undefined);
  const shownFavourites = () => favouriteBookmarks().map((bookmark) => bookmark.id);
  const existingOnly = (ids: readonly string[]) => ids.filter((id) => state.bookmarkById.has(id));
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
    const emptySubfolder =
      emptySubfolderId === null ? undefined : state.library.folderById.get(emptySubfolderId);
    renderSidebar(sidebarRoot, {
      folders: state.library.topFolders,
      selectedFolderId,
      colorOf: state.colorOf,
      onSelect: (folderId) => {
        selectedFolderId = folderId;
        emptySubfolderId = null;
        render();
      },
    });
    const shown = emptySubfolder?.topFolderId === selected?.id ? emptySubfolder : selected;
    const view = panelView(shown, favourites);
    editingFavourites = view.kind === "home" && view.editing;
    homeShowsFrequent =
      view.kind === "home" && view.sections.some((section) => section.id === "frequent");
    renderPanel(panelRoot, view, { colorOf: state.colorOf, decorate });
  };

  // Worked out from the stored favourites when saved, so pins made meanwhile in other tabs stay.
  const changeFavourites = async (
    change: (favourites: readonly string[]) => readonly string[],
  ): Promise<boolean> => {
    try {
      await settings.update((stored) => ({ favourites: change(existingOnly(stored.favourites)) }));
      return true;
    } catch (error: unknown) {
      warn("save your favourites", error);
      announcer.textContent = "Couldn't save your favourites.";
      return false;
    }
  };
  /** `toIndex` gives -1 to leave the favourites as they are. */
  const moveFavouriteTo = (id: string, toIndex: (favourites: readonly string[]) => number) => {
    void changeFavourites((favourites) => {
      const index = toIndex(favourites);
      return index < 0 ? favourites : moveFavourite(favourites, id, index);
    }).then((saved) => {
      if (!saved) return;
      const favourites = shownFavourites();
      const title = state.bookmarkById.get(id)?.title ?? "";
      announcer.textContent = `${title} moved to position ${favourites.indexOf(id) + 1} of ${favourites.length}.`;
    });
  };

  // The pin buttons are hidden once Home is full, but another tab may have filled it meanwhile.
  const togglePin = (id: string) => {
    let full = false;
    void changeFavourites((favourites) => {
      full = !favourites.includes(id) && favourites.length >= MAX_FAVOURITES;
      return toggleFavourite(favourites, id);
    }).then((saved) => {
      if (saved && full) announcer.textContent = "Favourites are full.";
    });
  };

  const open = (url: string, disposition: Disposition) => {
    void usage
      .recordVisit(url)
      .catch(warnOnFailure("record the visit"))
      .then(() => openUrl(url, disposition))
      .catch(warnOnFailure(`open ${url}`));
  };

  const openFolder = (folder: Folder) => {
    selectedFolderId = folder.topFolderId;
    emptySubfolderId =
      folder.totalBookmarks === 0 && folder.id !== folder.topFolderId ? folder.id : null;
    render();
    revealFolder(panelRoot, folder);
  };

  const findFolder = (id: string) => state.library.folderById.get(id);
  const search = (query: string, scopeFolderId: string | undefined): SpotlightResults => {
    const listing = scopeFolderId !== undefined && query === "";
    const results = currentIndex().search(query, {
      scopeFolderId,
      bookmarkBoost: (bookmark) => usage.boost(bookmark.url),
      ...(listing ? { folderLimit: SCOPED_LIMIT, bookmarkLimit: SCOPED_LIMIT } : {}),
    });
    const total = listing ? findFolder(scopeFolderId)?.totalBookmarks : undefined;
    return total !== undefined && total > results.bookmarks.length
      ? { ...results, total }
      : results;
  };

  const spotlight = new Spotlight({
    search,
    colorOf: (folder) => state.colorOf(folder),
    decorate,
    onOpenFolder: openFolder,
    onOpenBookmark: (bookmark, disposition) => {
      open(bookmark.url, disposition);
    },
    onSearchWeb: (query, disposition) => {
      searchWeb(query, disposition).catch(warnOnFailure("search the web"));
    },
  });
  requireElement("spotlight-slot").append(spotlight.element);

  const bookmarkUrls = () => state.library.bookmarks.map((bookmark) => bookmark.url);
  const settingsDialog = new SettingsDialog(settings, {
    folders: () => state.library.topFolders.flatMap(withSubfolders),
    siteCounts: () => {
      const origins = [...iconOrigins(bookmarkUrls())];
      return {
        cached: origins.filter((origin) => icons.hasCachedIcon(origin)).length,
        total: origins.length,
      };
    },
    redownload: () => {
      icons.request(bookmarkUrls(), true);
    },
  });

  icons.watch((origin) => {
    refreshIconTiles(document, origin, icons, (id) => state.bookmarkById.get(id));
    settingsDialog.refreshIcons();
  });
  icons.request(bookmarkUrls());

  const showBackground = (current: Settings) => {
    if (sameBackground(current.background, shownBackground)) return;
    shownBackground = current.background;
    void background.apply(shownBackground);
  };
  let rendered = settings.current;
  settings.subscribe((current) => {
    const previous = rendered;
    rendered = current;
    // Storage events parse into new arrays every time, so compare the labels by value.
    const labelsChanged = differ(previous.labels, current.labels);
    if (labelsChanged) {
      labelsOf = compileLabels(current.labels);
      index = undefined;
    }
    if (
      labelsChanged ||
      differ(previous.favourites, current.favourites) ||
      differ(previous.home, current.home)
    ) {
      render();
    }
    if (labelsChanged) spotlight.refresh(findFolder);
    showBackground(current);
  });
  // Another tab may have changed the background while the bookmarks loaded, before this subscribed.
  showBackground(settings.current);
  // Applied only as the page comes into view: re-sorting the cards under the pointer would make
  // the next click open a different bookmark.
  let otherTabsVisited = false;
  usage.subscribe(() => {
    otherTabsVisited = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !otherTabsVisited) return;
    otherTabsVisited = false;
    if (homeShowsFrequent) render();
  });

  const runPanelAction = (action: PanelAction, id: string | undefined) => {
    switch (action) {
      case "toggle-editing":
        editingFavourites = !editingFavourites;
        render();
        break;
      case "toggle-pin":
      case "unpin":
        if (id !== undefined) togglePin(id);
        break;
      case "move-earlier":
        if (id !== undefined) moveFavouriteTo(id, (favourites) => favourites.indexOf(id) - 1);
        break;
      case "move-later":
        if (id !== undefined) moveFavouriteTo(id, (favourites) => favourites.indexOf(id) + 1);
        break;
    }
  };
  bindPanelEvents(panelRoot, {
    open,
    runAction: runPanelAction,
    moveFavourite: (id, ontoId) => {
      moveFavouriteTo(id, (favourites) => favourites.indexOf(ontoId));
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
          settingsDialog.refresh();
        })
        .catch(warnOnFailure("reload bookmarks"));
    }, REBUILD_DELAY_MS);
  };
  onBookmarksChanged(rebuild);

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
