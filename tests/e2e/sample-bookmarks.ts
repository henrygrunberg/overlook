import type { Page, Worker } from "@playwright/test";

export interface SeedFolder {
  readonly title: string;
  readonly children: readonly SeedNode[];
}
export type SeedNode = SeedFolder | { readonly title: string; readonly url: string };

export const SAMPLE_BOOKMARKS: readonly SeedNode[] = [
  { title: "GitHub", url: "https://github.com/" },
  {
    title: "Work",
    children: [
      { title: "Jira board", url: "https://acme.atlassian.net/jira/software/boards/1" },
      { title: "Confluence", url: "https://acme.atlassian.net/wiki/spaces/acme" },
      {
        title: "Dashboards",
        children: [
          { title: "IoT Grafana", url: "http://10.0.0.20:3000/d/iot" },
          { title: "Load testing Grafana", url: "http://10.0.0.21:3000/d/load" },
        ],
      },
    ],
  },
  {
    title: "Reading",
    children: [
      { title: "Café analüütika", url: "https://notes.example.org/cafe" },
      { title: "Data handbook", url: "https://handbook.example.com/" },
    ],
  },
  {
    title: "Outdoors",
    children: [
      { title: "Trail map", url: "https://trails.example.com/" },
      { title: "Gear shop", url: "https://gear.example.com/" },
    ],
  },
];

async function createInBookmarksBar(tree: readonly SeedNode[]): Promise<void> {
  const create = async (parentId: string, node: SeedNode): Promise<void> => {
    if ("url" in node) {
      await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
      return;
    }
    const folder = await chrome.bookmarks.create({ parentId, title: node.title });
    for (const child of node.children) await create(folder.id, child);
  };
  for (const node of tree) await create("1", node);
}

export async function seedBookmarks(
  target: Page | Worker,
  nodes: readonly SeedNode[],
): Promise<void> {
  // Page and Worker evaluate overloads don't unify, so each branch narrows the type.
  if ("mainFrame" in target) await target.evaluate(createInBookmarksBar, nodes);
  else await target.evaluate(createInBookmarksBar, nodes);
}
