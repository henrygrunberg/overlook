import { buildLibrary, type BookmarkNode } from "../bookmarks/library";

type Entry = readonly [title: string, url: string] | readonly [title: string, children: Entry[]];

let nextId = 100;

function toNode([title, content]: Entry): BookmarkNode {
  const id = String(nextId++);
  return typeof content === "string"
    ? { id, title, url: content, dateAdded: nextId }
    : { id, title, children: content.map(toNode) };
}

export const SAMPLE_TREE: BookmarkNode[] = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        title: "Bookmarks bar",
        children: (
          [
            ["GitHub", "https://github.com/"],
            [
              "Work",
              [
                ["Jira board", "https://acme.atlassian.net/jira/software/boards/1"],
                ["Confluence", "https://acme.atlassian.net/wiki/spaces/acme"],
                [
                  "Dashboards",
                  [
                    ["IoT Grafana", "http://10.0.0.20:3000/d/iot"],
                    ["Load testing Grafana", "http://10.0.0.21:3000/d/load"],
                  ],
                ],
              ],
            ],
            [
              "Reading",
              [
                ["Café analüütika", "https://notes.example.org/cafe"],
                ["Data handbook", "https://handbook.example.com/"],
              ],
            ],
            [
              "Outdoors",
              [
                ["Trail map", "https://trails.example.com/"],
                ["Gear shop", "https://gear.example.com/"],
              ],
            ],
          ] satisfies Entry[]
        ).map(toNode),
      },
    ],
  },
];

export const sampleLibrary = buildLibrary(SAMPLE_TREE);

export function folderNamed(title: string) {
  const folder = sampleLibrary.folders.find((candidate) => candidate.title === title);
  if (!folder) throw new Error(`No sample folder named ${title}`);
  return folder;
}

export function bookmarkNamed(title: string) {
  const bookmark = sampleLibrary.bookmarks.find((candidate) => candidate.title === title);
  if (!bookmark) throw new Error(`No sample bookmark named ${title}`);
  return bookmark;
}
