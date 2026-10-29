import type { Bookmark, Folder, Library } from "../bookmarks/library";
import type { HomeSettings } from "../settings/settings";
import type { UsageStore } from "../usage/usage-store";

const FREQUENT_LIMIT = 8;

export interface HomeSection {
  readonly id: "favourites" | "frequent";
  readonly title: string;
  readonly note: string;
  readonly bookmarks: readonly Bookmark[];
  readonly emptyText: string;
}

export type HomeView =
  | { readonly kind: "sections"; readonly sections: readonly HomeSection[] }
  | { readonly kind: "folder"; readonly folder: Folder };

function uniqueByUrl(bookmarks: readonly Bookmark[]): Map<string, Bookmark> {
  const byUrl = new Map<string, Bookmark>();
  for (const bookmark of bookmarks) if (!byUrl.has(bookmark.url)) byUrl.set(bookmark.url, bookmark);
  return byUrl;
}

export function frequentSection(
  library: Library,
  usage: UsageStore,
  excludedUrls: ReadonlySet<string>,
  now = Date.now(),
): HomeSection {
  const byUrl = uniqueByUrl(
    library.bookmarks.filter((bookmark) => !excludedUrls.has(bookmark.url)),
  );
  const frequent = usage
    .mostUsed(FREQUENT_LIMIT, now, (url) => byUrl.has(url))
    .map((url) => byUrl.get(url))
    .filter((bookmark) => bookmark !== undefined);
  const shown = new Set(frequent.map((bookmark) => bookmark.url));
  const newest = [...byUrl.values()]
    .filter((bookmark) => !shown.has(bookmark.url))
    .sort((a, b) => b.dateAdded - a.dateAdded)
    .slice(0, FREQUENT_LIMIT - frequent.length);

  return {
    id: "frequent",
    title: frequent.length > 0 ? "Frequent" : "Recently added",
    note: frequent.length > 0 ? "Your most-used links" : "Your most-used links will show up here",
    bookmarks: [...frequent, ...newest],
    emptyText: "No bookmarks yet. Add some in your browser and they will show up here.",
  };
}

export function homeView(
  library: Library,
  usage: UsageStore,
  home: HomeSettings,
  favourites: readonly Bookmark[],
  now = Date.now(),
): HomeView {
  if (home.source === "folder") {
    const folder = home.folderId === null ? undefined : library.folderById.get(home.folderId);
    if (folder) return { kind: "folder", folder };
  }
  if (home.source === "frequent") {
    return { kind: "sections", sections: [frequentSection(library, usage, new Set(), now)] };
  }

  const favouritesSection: HomeSection = {
    id: "favourites",
    title: "Favourites",
    note: "Pinned by you",
    bookmarks: favourites,
    emptyText: "Nothing pinned yet. Hover over any bookmark and click ☆ to keep it here.",
  };
  const pinnedUrls = new Set(favourites.map((bookmark) => bookmark.url));
  return {
    kind: "sections",
    sections: home.showFrequent
      ? [favouritesSection, frequentSection(library, usage, pinnedUrls, now)]
      : [favouritesSection],
  };
}
