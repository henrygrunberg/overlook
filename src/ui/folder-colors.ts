import type { Folder } from "../bookmarks/library";

// macOS system accent colours, in an order that keeps neighbours distinct.
const PALETTE = [
  "#0A84FF",
  "#FF9F0A",
  "#30D158",
  "#40C8E0",
  "#FFD60A",
  "#BF5AF2",
  "#FF375F",
  "#5E5CE6",
  "#FF453A",
  "#66D4CF",
  "#AC8E68",
] as const;

export type FolderColors = (item: Pick<Folder, "topFolderId">) => string;

export function folderColors(topFolders: readonly Folder[]): FolderColors {
  const byTopFolder = new Map(
    topFolders.map((folder, index) => [folder.id, PALETTE[index % PALETTE.length] ?? PALETTE[0]]),
  );
  return (folder) => byTopFolder.get(folder.topFolderId) ?? PALETTE[0];
}
