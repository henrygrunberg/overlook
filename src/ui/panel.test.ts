import { describe, expect, it, vi } from "vitest";
import { buildLibrary, type Bookmark } from "../bookmarks/library";
import type { IconState } from "../favicons/icon-library";
import { compileLabels } from "../labels/labels";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { bookmarkNamed, folderNamed, sampleLibrary } from "../test/sample-library";
import { folderColors } from "./folder-colors";
import { folderSections, renderPanel, type PanelDecor, type PanelView } from "./panel";

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
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://overlook-test${path}` },
  });
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
});
