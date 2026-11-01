import { isPrivateNetworkHost } from "../private-network";

export interface Bookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** Host for display, without "www.". */
  readonly host: string;
  /** Exact host name, lower-case, for matching label rules. */
  readonly hostname: string;
  readonly dateAdded: number;
  readonly folderId: string;
  readonly topFolderId: string;
  /** Folder titles from the top-level folder down to the bookmark's own folder. */
  readonly path: readonly string[];
  readonly ancestorIds: readonly string[];
  readonly isPrivateNetwork: boolean;
}

export interface Folder {
  readonly id: string;
  readonly title: string;
  readonly topFolderId: string;
  /** Folder titles from the top-level folder down to and including this folder. */
  readonly path: readonly string[];
  readonly ancestorIds: readonly string[];
  readonly bookmarks: readonly Bookmark[];
  readonly subfolders: readonly Folder[];
  readonly totalBookmarks: number;
  /** A permanent root's own bookmarks, shown as a folder named after the root. */
  readonly holdsLooseBookmarks: boolean;
}

export interface Library {
  readonly topFolders: readonly Folder[];
  readonly folders: readonly Folder[];
  readonly bookmarks: readonly Bookmark[];
  readonly folderById: ReadonlyMap<string, Folder>;
}

/** The parts of `chrome.bookmarks.BookmarkTreeNode` the library is built from. */
export interface BookmarkNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string | undefined;
  readonly dateAdded?: number | undefined;
  readonly syncing?: boolean | undefined;
  readonly children?: readonly BookmarkNode[] | undefined;
}

const OPENABLE_PROTOCOLS = new Set([
  "http:",
  "https:",
  "ftp:",
  "file:",
  "chrome:",
  "brave:",
  "edge:",
  "vivaldi:",
  "opera:",
  "chrome-extension:",
  "about:",
]);

const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ftp:"]);

export function parseBookmarkUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return OPENABLE_PROTOCOLS.has(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

const withoutTrailingDots = (hostname: string) => hostname.replace(/\.+$/, "");

function displayHost(url: URL): string {
  return withoutTrailingDots(url.hostname).replace(/^www\./, "") || url.protocol.replace(":", "");
}

interface FolderContext {
  readonly topFolderId: string;
  readonly path: readonly string[];
  readonly ancestorIds: readonly string[];
}

function folderTitle(node: BookmarkNode): string {
  return node.title.trim() || "Untitled folder";
}

function buildFolder(
  node: BookmarkNode,
  title: string,
  parent: FolderContext,
  folders: Folder[],
  holdsLooseBookmarks = false,
): Folder {
  const inside: FolderContext = {
    topFolderId: parent.topFolderId,
    path: [...parent.path, title],
    ancestorIds: [...parent.ancestorIds, node.id],
  };
  const bookmarks: Bookmark[] = [];
  const subfolders: Folder[] = [];

  for (const child of node.children ?? []) {
    if (child.url === undefined) {
      subfolders.push(buildFolder(child, folderTitle(child), inside, folders));
      continue;
    }
    const url = parseBookmarkUrl(child.url);
    if (!url) continue;
    const host = displayHost(url);
    bookmarks.push({
      id: child.id,
      title: child.title.trim() || (url.hostname ? host : url.href),
      url: url.href,
      host,
      hostname: withoutTrailingDots(url.hostname.toLowerCase()),
      dateAdded: child.dateAdded ?? 0,
      folderId: node.id,
      topFolderId: inside.topFolderId,
      path: inside.path,
      ancestorIds: inside.ancestorIds,
      isPrivateNetwork: NETWORK_PROTOCOLS.has(url.protocol) && isPrivateNetworkHost(url.hostname),
    });
  }

  const folder: Folder = {
    id: node.id,
    title,
    topFolderId: inside.topFolderId,
    path: inside.path,
    ancestorIds: parent.ancestorIds,
    bookmarks,
    subfolders,
    totalBookmarks:
      bookmarks.length + subfolders.reduce((sum, subfolder) => sum + subfolder.totalBookmarks, 0),
    holdsLooseBookmarks,
  };
  folders.push(folder);
  return folder;
}

interface TopFolderSource {
  readonly node: BookmarkNode;
  readonly root: BookmarkNode;
  readonly title: string;
  readonly holdsLooseBookmarks: boolean;
}

function topFolderSources(root: BookmarkNode): TopFolderSource[] {
  const children = root.children ?? [];
  const subfolders = children
    .filter((child) => child.url === undefined)
    .map((node) => ({ node, root, title: folderTitle(node), holdsLooseBookmarks: false }));
  const looseBookmarks = children.filter(
    (child) => child.url !== undefined && parseBookmarkUrl(child.url) !== null,
  );
  if (looseBookmarks.length === 0) return subfolders;
  const looseFolder = { ...root, children: looseBookmarks };
  return [
    ...subfolders,
    { node: looseFolder, root, title: root.title || "Bookmarks", holdsLooseBookmarks: true },
  ];
}

// Two roots can hold folders of the same name, and with account storage on, a root can have a
// copy that stays on this device under the same name.
function withDistinctTitles(sources: readonly TopFolderSource[]): TopFolderSource[] {
  const count = (keys: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const byTitle = count(sources.map(({ title }) => title));
  const byTitleAndRoot = count(sources.map(({ title, root }) => `${title}\n${root.title}`));
  const distinctTitle = ({ title, root }: TopFolderSource) => {
    if ((byTitle.get(title) ?? 0) < 2) return title;
    if ((byTitleAndRoot.get(`${title}\n${root.title}`) ?? 0) < 2) return `${title} (${root.title})`;
    return root.syncing === false ? `${title} (this device)` : title;
  };
  return sources.map((source) => ({ ...source, title: distinctTitle(source) }));
}

/**
 * Permanent roots (Bookmarks bar, Other bookmarks, …) aren't shown: their subfolders become
 * top-level folders, and their loose bookmarks a folder named after the root.
 */
export function buildLibrary(tree: readonly BookmarkNode[]): Library {
  const folders: Folder[] = [];
  const sources = tree.flatMap((root) => root.children ?? []).flatMap(topFolderSources);
  const topFolders = withDistinctTitles(sources).map(({ node, title, holdsLooseBookmarks }) =>
    buildFolder(
      node,
      title,
      { topFolderId: node.id, path: [], ancestorIds: [] },
      folders,
      holdsLooseBookmarks,
    ),
  );

  // In tree order, so where a URL is bookmarked twice the copy nearer the top comes first.
  const built = new Map(
    folders.flatMap((folder) => folder.bookmarks).map((bookmark) => [bookmark.id, bookmark]),
  );
  const inTreeOrder = (nodes: readonly BookmarkNode[]): Bookmark[] =>
    nodes.flatMap((node) =>
      node.url === undefined ? inTreeOrder(node.children ?? []) : (built.get(node.id) ?? []),
    );

  return {
    topFolders,
    folders,
    bookmarks: inTreeOrder(tree),
    folderById: new Map(folders.map((folder) => [folder.id, folder])),
  };
}
