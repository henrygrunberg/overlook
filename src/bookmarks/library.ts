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

function displayHost(url: URL): string {
  return url.hostname.replace(/^www\./, "") || url.protocol.replace(":", "");
}

interface FolderContext {
  readonly topFolderId: string;
  readonly path: readonly string[];
  readonly ancestorIds: readonly string[];
}

function folderTitle(node: BookmarkNode): string {
  return node.title || "Untitled folder";
}

function buildFolder(
  node: BookmarkNode,
  title: string,
  parent: FolderContext,
  folders: Folder[],
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
      title: child.title.trim() || host,
      url: url.href,
      host,
      hostname: url.hostname.toLowerCase(),
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
      bookmarks.length + subfolders.reduce((sum, folder) => sum + folder.totalBookmarks, 0),
  };
  folders.push(folder);
  return folder;
}

/**
 * Permanent roots (Bookmarks bar, Other bookmarks, …) aren't shown: their subfolders become
 * top-level folders, and their loose bookmarks a folder named after the root.
 */
export function buildLibrary(tree: readonly BookmarkNode[]): Library {
  const folders: Folder[] = [];
  const topFolders: Folder[] = [];
  const permanentRoots = tree.flatMap((root) => root.children ?? []);

  for (const root of permanentRoots) {
    const children = root.children ?? [];
    for (const child of children) {
      if (child.url !== undefined) continue;
      const top = { topFolderId: child.id, path: [], ancestorIds: [] };
      topFolders.push(buildFolder(child, folderTitle(child), top, folders));
    }
    const looseBookmarks = children.filter(
      (child) => child.url !== undefined && parseBookmarkUrl(child.url) !== null,
    );
    if (looseBookmarks.length > 0) {
      const top = { topFolderId: root.id, path: [], ancestorIds: [] };
      const looseFolder = { ...root, children: looseBookmarks };
      topFolders.push(buildFolder(looseFolder, root.title || "Bookmarks", top, folders));
    }
  }

  return {
    topFolders,
    folders,
    bookmarks: folders.flatMap((folder) => folder.bookmarks),
    folderById: new Map(folders.map((folder) => [folder.id, folder])),
  };
}
