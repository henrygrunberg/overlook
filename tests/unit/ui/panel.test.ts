import { describe, expect, it } from "vitest";
import {
  buildLibrary,
  type Bookmark,
  type BookmarkNode,
  type Library,
} from "../../../src/bookmarks/library";
import type { IconState } from "../../../src/favicons/icon-library";
import { compileLabels } from "../../../src/labels/labels";
import { DEFAULT_SETTINGS } from "../../../src/settings/settings";
import { bookmarkNamed, folderNamed, sampleLibrary } from "../fixtures/sample-library";
import { folderColors } from "../../../src/ui/folder-colors";
import {
  folderSections,
  renderPanel,
  type PanelDecor,
  type PanelView,
} from "../../../src/ui/panel";

describe("folderSections", () => {
  it("lists the folder's own bookmarks first, then nested folders by relative path", () => {
    const sections = folderSections(folderNamed("Work"));
    expect(sections.map((section) => section.heading)).toEqual([null, "Dashboards"]);
    expect(sections[1]?.bookmarks.map((bookmark) => bookmark.title)).toEqual([
      "IoT Grafana",
      "Load testing Grafana",
    ]);
  });

  it("skips folders without bookmarks of their own", () => {
    const library = buildLibrary([
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            children: [
              {
                id: "10",
                title: "Reading",
                children: [
                  {
                    id: "11",
                    title: "Papers",
                    children: [{ id: "12", title: "Paper", url: "https://papers.example.org/" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const [reading] = library.topFolders;
    if (!reading) throw new Error("No top folder");
    expect(folderSections(reading).map((section) => section.heading)).toEqual(["Papers"]);
  });
});

function homeWith(favourites: readonly Bookmark[], editing = false): PanelView {
  return {
    kind: "home",
    editing,
    sections: [
      {
        id: "favourites",
        title: "Favourites",
        note: "Pinned by you",
        bookmarks: favourites,
        emptyText: "Nothing pinned yet.",
      },
    ],
  };
}

describe("renderPanel", () => {
  const colorOf = folderColors(sampleLibrary.topFolders);
  const labelsOf = compileLabels(DEFAULT_SETTINGS.labels);
  const iconStates = new Map<string, IconState>([
    ["https://acme.atlassian.net", { kind: "image", src: "blob:jira", fullBleed: true }],
  ]);
  const decor: PanelDecor = {
    colorOf,
    decorate: (bookmark) => ({
      color: colorOf(bookmark),
      labels: labelsOf(bookmark),
      icons: { iconFor: (url) => iconStates.get(new URL(url).origin) ?? { kind: "none" } },
      pinned: false,
      canPin: true,
    }),
  };

  it("renders bookmark titles as text, never as markup", () => {
    const root = document.createElement("main");
    const evil: Bookmark = { ...bookmarkNamed("Jira board"), title: "<b>bold</b>" };
    renderPanel(root, homeWith([evil]), decor);

    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector(".link-card__title")?.textContent).toBe("<b>bold</b>");
  });

  it("shows label chips from the label rules", () => {
    const root = document.createElement("main");
    renderPanel(root, { kind: "folder", folder: folderNamed("Dashboards"), isHome: false }, decor);
    const chips = [...root.querySelectorAll(".chip")].map((chip) => chip.textContent);
    expect(chips).toEqual(["VPN", "VPN"]);
  });

  it("uses cached icons, full-bleed when they cover the tile, and letters otherwise", () => {
    const root = document.createElement("main");
    renderPanel(root, { kind: "folder", folder: folderNamed("Work"), isHome: false }, decor);
    const tile = (title: string) =>
      [...root.querySelectorAll(".link-card")]
        .find((card) => card.textContent.includes(title))
        ?.querySelector(".favicon-tile");

    expect(tile("Jira board")?.querySelector("img")?.getAttribute("src")).toBe("blob:jira");
    expect(tile("Jira board")?.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(tile("Jira board")?.classList).toContain("favicon-tile--full-bleed");
    expect(tile("IoT Grafana")?.textContent).toBe("I");
    expect(tile("IoT Grafana")?.classList).toContain("favicon-tile--monogram");
  });

  it("shows an empty state for an empty folder", () => {
    const root = document.createElement("main");
    renderPanel(root, { kind: "folder", folder: folderNamed("Outdoors"), isHome: false }, decor);
    expect(root.querySelector(".panel__empty")).toBeNull();

    const empty = { ...folderNamed("Outdoors"), bookmarks: [], subfolders: [], totalBookmarks: 0 };
    renderPanel(root, { kind: "folder", folder: empty, isHome: false }, decor);
    expect(root.querySelector(".panel__empty")?.textContent).toBe("This folder is empty.");
    expect(root.querySelector(".panel__note")?.textContent).toBe("0 bookmarks");
  });

  it("names a nested folder by its path, with its direction left to the browser", () => {
    const root = document.createElement("main");
    const empty = { ...folderNamed("Dashboards"), bookmarks: [], totalBookmarks: 0 };
    renderPanel(root, { kind: "folder", folder: empty, isHome: false }, decor);
    const title = root.querySelector(".panel__title");
    expect(title?.textContent).toBe("Work › Dashboards");
    expect(title?.getAttribute("dir")).toBe("auto");
    expect(root.querySelector(".panel__empty")?.textContent).toBe("This folder is empty.");

    renderPanel(root, { kind: "folder", folder: folderNamed("Work"), isHome: false }, decor);
    expect(root.querySelector(".panel__title")?.textContent).toBe("Work");
    expect(root.querySelector(".panel__section-title")?.getAttribute("dir")).toBe("auto");
  });
});

describe("renderPanel favourites", () => {
  const colorOf = folderColors(sampleLibrary.topFolders);
  const pinned = new Set([bookmarkNamed("GitHub").id]);
  const decor: PanelDecor = {
    colorOf,
    decorate: (bookmark) => ({
      color: colorOf(bookmark),
      labels: [],
      icons: { iconFor: () => ({ kind: "none" }) },
      pinned: pinned.has(bookmark.id),
      canPin: true,
    }),
  };
  const actions = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLButtonElement>("[data-action]")].map((button) => ({
      action: button.dataset.action,
      label: button.getAttribute("aria-label") ?? button.textContent,
      disabled: button.disabled,
    }));

  it("offers a star on every card, saying whether it pins or unpins", () => {
    const root = document.createElement("main");
    renderPanel(root, { kind: "folder", folder: folderNamed("Work"), isHome: false }, decor);
    expect(actions(root)[0]).toEqual({
      action: "toggle-pin",
      label: "Pin Jira board to Home",
      disabled: false,
    });

    renderPanel(root, homeWith([bookmarkNamed("GitHub")]), decor);
    expect(actions(root).map((action) => action.label)).toEqual(["Edit", "Unpin GitHub from Home"]);
  });

  it("swaps the star for move and unpin buttons while editing", () => {
    const root = document.createElement("main");
    const favourites = [bookmarkNamed("GitHub"), bookmarkNamed("Trail map")];
    renderPanel(root, homeWith(favourites, true), decor);

    expect(root.dataset.editing).toBe("true");
    expect(actions(root).slice(1, 4)).toEqual([
      { action: "move-earlier", label: "Move GitHub earlier", disabled: true },
      { action: "move-later", label: "Move GitHub later", disabled: false },
      { action: "unpin", label: "Unpin GitHub", disabled: false },
    ]);
    expect(root.querySelector("[data-favourite-index='1']")?.getAttribute("draggable")).toBe(
      "true",
    );
    expect(root.querySelector(".link-card")?.getAttribute("tabindex")).toBe("-1");
  });

  it("explains how to pin when there are no favourites, without an Edit button", () => {
    const root = document.createElement("main");
    renderPanel(root, homeWith([]), decor);
    expect(root.querySelector(".panel__empty")?.textContent).toBe("Nothing pinned yet.");
    expect(root.querySelector("[data-action=toggle-editing]")).toBeNull();
  });

  it("keeps focus on the same button after re-rendering", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const favourites = [bookmarkNamed("GitHub"), bookmarkNamed("Trail map")];
    renderPanel(root, homeWith(favourites, true), decor);
    root.querySelector<HTMLButtonElement>("[aria-label='Move Trail map earlier']")?.focus();

    renderPanel(root, homeWith([...favourites].reverse(), true), decor);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move Trail map later");
    root.remove();
  });

  it("keeps focus on the same card link after re-rendering", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const view: PanelView = { kind: "folder", folder: folderNamed("Work"), isHome: false };
    renderPanel(root, view, decor);
    const confluence = () =>
      [...root.querySelectorAll<HTMLElement>(".link-card")].find((card) =>
        card.textContent.includes("Confluence"),
      );
    confluence()?.focus();

    renderPanel(root, view, decor);
    expect(document.activeElement).toBe(confluence());
    root.remove();
  });

  it("moves focus to the card's link when its focused star becomes disabled", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const view: PanelView = { kind: "folder", folder: folderNamed("Outdoors"), isHome: false };
    renderPanel(root, view, decor);
    root.querySelector<HTMLButtonElement>("[aria-label='Pin Trail map to Home']")?.focus();

    const homeFull: PanelDecor = {
      ...decor,
      decorate: (bookmark) => ({ ...decor.decorate(bookmark), canPin: false }),
    };
    renderPanel(root, view, homeFull);
    const trailMap = root.querySelector("[data-bookmark-url='https://trails.example.com/']");
    expect(document.activeElement).toBe(trailMap);
    root.remove();
  });

  it("moves focus to the panel title when the last favourite is unpinned", () => {
    const root = document.createElement("main");
    document.body.append(root);
    renderPanel(root, homeWith([bookmarkNamed("GitHub")], true), decor);
    root.querySelector<HTMLButtonElement>("[aria-label='Unpin GitHub']")?.focus();

    renderPanel(root, homeWith([]), decor);
    expect(document.activeElement).toBe(root.querySelector(".panel__title"));

    renderPanel(root, homeWith([]), decor);
    expect(document.activeElement).toBe(root.querySelector(".panel__title"));
    root.remove();
  });

  it("names the Edit button by what it does, without a pressed state", () => {
    const root = document.createElement("main");
    renderPanel(root, homeWith([bookmarkNamed("GitHub")], true), decor);
    const toggle = root.querySelector("[data-action=toggle-editing]");
    expect(toggle?.textContent).toBe("Done");
    expect(toggle?.hasAttribute("aria-pressed")).toBe(false);
  });
});

describe("folderColors", () => {
  it("gives nested folders their top folder's colour and neighbours different ones", () => {
    const colorOf = folderColors(sampleLibrary.topFolders);
    expect(colorOf(folderNamed("Dashboards"))).toBe(colorOf(folderNamed("Work")));
    expect(colorOf(folderNamed("Work"))).not.toBe(colorOf(folderNamed("Reading")));
  });

  it("gives neighbouring folders different colours whatever their ids", () => {
    const library = buildLibrary([
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            children: [5, 14, 30, 40].map((id) => ({
              id: String(id),
              title: `Folder ${id}`,
              children: [{ id: `${id}1`, title: "Acme", url: "https://acme.example.com/" }],
            })),
          },
        ],
      },
    ]);
    const colorOf = folderColors(library.topFolders);
    expect(new Set(library.topFolders.map(colorOf)).size).toBe(library.topFolders.length);
  });

  const folderNodes = (first: number, count: number): BookmarkNode[] =>
    Array.from({ length: count }, (_, index) => ({
      id: String(first + index),
      title: `Folder ${first + index}`,
      children: [{ id: `${first + index}-1`, title: "Acme", url: "https://acme.example.com/" }],
    }));
  const looseBookmark = (id: string): BookmarkNode => ({
    id,
    title: "Loose",
    url: "https://loose.example.com/",
  });

  it.each([
    [10, 2],
    [11, 2],
    [21, 2],
    [10, 0],
  ])(
    "gives loose-bookmark folders colours unlike their neighbours' with %i bar folders and %i other",
    (barFolders, otherFolders) => {
      const library = buildLibrary([
        {
          id: "0",
          title: "",
          children: [
            {
              id: "1",
              title: "Bookmarks bar",
              children: [...folderNodes(100, barFolders), looseBookmark("190")],
            },
            {
              id: "2",
              title: "Other bookmarks",
              children: [...folderNodes(200, otherFolders), looseBookmark("290")],
            },
            { id: "3", title: "Mobile bookmarks", children: [looseBookmark("390")] },
          ],
        },
      ]);
      const colours = library.topFolders.map(folderColors(library.topFolders));
      for (let index = 1; index < colours.length; index++) {
        expect(colours[index], library.topFolders[index]?.title).not.toBe(colours[index - 1]);
      }
    },
  );

  it.each([0, 10, 11])(
    "keeps each folder's colour when a loose bookmark adds its root's folder before it, after %i bar folders",
    (barFolders) => {
      const tree = (barChildren: BookmarkNode[]): BookmarkNode[] => [
        {
          id: "0",
          title: "",
          children: [
            {
              id: "1",
              title: "Bookmarks bar",
              children: [...folderNodes(100, barFolders), ...barChildren],
            },
            {
              id: "2",
              title: "Other bookmarks",
              children: [10, 11, 12, 13].map((id) => ({
                id: String(id),
                title: `Folder ${id}`,
                children: [{ id: `${id}1`, title: "Acme", url: "https://acme.example.com/" }],
              })),
            },
          ],
        },
      ];
      const before = buildLibrary(tree([]));
      const after = buildLibrary(
        tree([{ id: "20", title: "Loose", url: "https://loose.example.com/" }]),
      );
      expect(after.topFolders).toHaveLength(before.topFolders.length + 1);
      const colours = (library: Library) =>
        before.topFolders.map((folder) => folderColors(library.topFolders)(folder));
      expect(colours(after)).toEqual(colours(before));
      const shown = after.topFolders.map(folderColors(after.topFolders));
      for (let index = 1; index < shown.length; index++) {
        expect(shown[index]).not.toBe(shown[index - 1]);
      }
    },
  );
});
