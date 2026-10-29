import { describe, expect, it } from "vitest";
import { buildLibrary, parseBookmarkUrl, type BookmarkNode } from "./library";

const tree: BookmarkNode[] = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        title: "Bookmarks bar",
        children: [
          { id: "10", title: "GitHub", url: "https://github.com/", dateAdded: 5 },
          {
            id: "20",
            title: "Acme",
            children: [
              { id: "21", title: "Jira board", url: "https://acme.atlassian.net/jira" },
              {
                id: "22",
                title: "Dashboards",
                children: [
                  { id: "23", title: "IoT Grafana", url: "http://10.0.0.20:3000/d/x" },
                  {
                    id: "24",
                    title: "Old",
                    children: [{ id: "25", title: "", url: "https://www.grafana.com/" }],
                  },
                ],
              },
              { id: "26", title: "Bookmarklet", url: "javascript:alert(1)" },
              { id: "27", title: "Intranet", url: "http://wiki/" },
              { id: "28", title: "Browser settings", url: "chrome://Settings/" },
            ],
          },
        ],
      },
      {
        id: "2",
        title: "Other bookmarks",
        children: [
          { id: "30", title: "Outdoors", children: [] },
          { id: "31", title: "Bookmarklet", url: "javascript:void(0)" },
        ],
      },
      { id: "3", title: "Mobile bookmarks", children: [] },
    ],
  },
];

const library = buildLibrary(tree);

describe("buildLibrary", () => {
  it("promotes folders inside the permanent roots to top-level folders", () => {
    expect(library.topFolders.map((folder) => folder.title)).toEqual([
      "Acme",
      "Bookmarks bar",
      "Outdoors",
    ]);
  });

  it("collects loose bookmarks of a root into a folder named after the root", () => {
    const bar = library.folderById.get("1");
    expect(bar?.bookmarks.map((bookmark) => bookmark.title)).toEqual(["GitHub"]);
    expect(bar?.subfolders).toEqual([]);
  });

  it("makes no folder for a root without loose bookmarks it can open", () => {
    expect(library.folderById.has("2")).toBe(false);
    expect(library.folderById.has("3")).toBe(false);
  });

  it("keeps the folder path and ancestry of nested bookmarks", () => {
    const old = library.bookmarks.find((bookmark) => bookmark.id === "25");
    expect(old?.path).toEqual(["Acme", "Dashboards", "Old"]);
    expect(old?.ancestorIds).toEqual(["20", "22", "24"]);
    expect(old?.topFolderId).toBe("20");
    expect(library.folderById.get("24")).toMatchObject({
      title: "Old",
      path: ["Acme", "Dashboards", "Old"],
      ancestorIds: ["20", "22"],
      topFolderId: "20",
    });
  });

  it("falls back to the host for untitled bookmarks and strips www", () => {
    expect(library.bookmarks.find((bookmark) => bookmark.id === "25")?.title).toBe("grafana.com");
  });

  it("counts bookmarks recursively", () => {
    expect(library.folderById.get("20")?.totalBookmarks).toBe(5);
    expect(library.folderById.get("30")?.totalBookmarks).toBe(0);
  });

  it("flags private-network bookmarks", () => {
    const grafana = library.bookmarks.find((bookmark) => bookmark.id === "23");
    expect(grafana?.isPrivateNetwork).toBe(true);
    expect(grafana?.host).toBe("10.0.0.20");
    expect(library.bookmarks.find((bookmark) => bookmark.id === "27")?.isPrivateNetwork).toBe(true);
  });

  it("doesn't flag browser pages, whose host is a single word too", () => {
    expect(library.bookmarks.find((bookmark) => bookmark.id === "28")?.isPrivateNetwork).toBe(
      false,
    );
  });

  it("lower-cases host names that the URL parser leaves as written", () => {
    expect(library.bookmarks.find((bookmark) => bookmark.id === "28")?.hostname).toBe("settings");
  });
});

describe("parseBookmarkUrl", () => {
  it.each([
    "https://a.example.com",
    "http://192.168.1.1:8000/x",
    "file:///Users/me/a.pdf",
    "brave://settings",
  ])("accepts %s", (url) => {
    expect(parseBookmarkUrl(url)).not.toBeNull();
  });

  it.each(["javascript:void(0)", "data:text/html,<b>x</b>", "not a url"])("rejects %s", (url) => {
    expect(parseBookmarkUrl(url)).toBeNull();
  });
});
