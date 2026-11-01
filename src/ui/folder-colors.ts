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

// Folders take the palette in order, so neighbours differ. The roots' loose-bookmark folders count
// from the other end, so one appearing or going doesn't repaint every folder after it, and step
// past the colours of the folders on either side of them.
export function folderColors(topFolders: readonly Folder[]): FolderColors {
  const byTopFolder = new Map<string, string>();
  let folders = 0;
  let looseFolders = 0;
  let previous: number | undefined;
  for (const folder of topFolders) {
    const nextFolderIndex = folders % PALETTE.length;
    let index = nextFolderIndex;
    if (folder.holdsLooseBookmarks) {
      index = PALETTE.length - 1 - (looseFolders++ % PALETTE.length);
      while (index === previous || index === nextFolderIndex) {
        index = (index + PALETTE.length - 1) % PALETTE.length;
      }
    } else {
      folders++;
    }
    byTopFolder.set(folder.id, PALETTE[index] ?? PALETTE[0]);
    previous = index;
  }
  return (folder) => byTopFolder.get(folder.topFolderId) ?? PALETTE[0];
}
