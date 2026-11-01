import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../../src/app";
import type { BookmarkNode } from "../../src/bookmarks/library";
import {
  DEFAULT_SETTINGS,
  type BackgroundChoice,
  type Settings,
} from "../../src/settings/settings";
import { SettingsStore } from "../../src/settings/settings-store";
import { SAMPLE_TREE, bookmarkNamed, folderNamed } from "./fixtures/sample-library";
import type { SettingsContext } from "../../src/ui/settings-dialog";

const appliedBackgrounds = vi.hoisted(() => [] as BackgroundChoice[]);
vi.mock("../../src/ui/background-view", () => ({
  BackgroundView: class {
    apply(choice: BackgroundChoice) {
      appliedBackgrounds.push(choice);
      return Promise.resolve();
    }
  },
}));
const dialogContexts = vi.hoisted(() => [] as SettingsContext[]);
const dialogRefreshes = vi.hoisted(() => ({ bookmarks: 0, icons: 0 }));
vi.mock("../../src/ui/settings-dialog", () => ({
  SettingsDialog: class {
    constructor(_settings: unknown, context: SettingsContext) {
      dialogContexts.push(context);
    }
    open() {
      return Promise.resolve();
    }
    refresh() {
      dialogRefreshes.bookmarks++;
    }
    refreshIcons() {
      dialogRefreshes.icons++;
    }
  },
}));
const iconWatchers = vi.hoisted(() => [] as ((origin: string) => void)[]);
const cachedIconOrigins = vi.hoisted(() => new Set<string>());
vi.mock("../../src/favicons/icon-library", () => ({
  IconLibrary: {
    load: () =>
      Promise.resolve({
        hasCachedIcon: (origin: string) => cachedIconOrigins.has(origin),
        iconFor: () => ({ kind: "none" }),
        watch: (watcher: (origin: string) => void) => iconWatchers.push(watcher),
        request: () => undefined,
      }),
  },
}));

type Listener = (...args: unknown[]) => void;

function fakeChrome(settings: Partial<Settings>, initialTree: readonly BookmarkNode[]) {
  let tree = initialTree;
  const stored: Record<string, unknown> = { settings: { ...DEFAULT_SETTINGS, ...settings } };
  const bookmarkListeners: Listener[] = [];
  const storageListeners: Listener[] = [];
  const localListeners: Listener[] = [];
  const bookmarkEvent = { addListener: (listener: Listener) => bookmarkListeners.push(listener) };
  vi.stubGlobal("chrome", {
    bookmarks: {
      getTree: () => Promise.resolve(tree),
      onCreated: bookmarkEvent,
      onRemoved: bookmarkEvent,
      onChanged: bookmarkEvent,
      onMoved: bookmarkEvent,
      onChildrenReordered: bookmarkEvent,
      onImportEnded: bookmarkEvent,
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in stored ? { [key]: stored[key] } : {}),
        set: (items: Record<string, unknown>) => {
          Object.assign(stored, items);
          const changes = Object.fromEntries(
            Object.entries(items).map(([key, newValue]) => [key, { newValue }]),
          );
          for (const listener of storageListeners) listener(changes, "local");
          for (const listener of localListeners) listener(changes);
          return Promise.resolve();
        },
        onChanged: { addListener: (listener: Listener) => localListeners.push(listener) },
      },
      onChanged: { addListener: (listener: Listener) => storageListeners.push(listener) },
    },
    runtime: { getURL: (path: string) => `chrome-extension://overlook-test/${path}` },
  });
  const changeBookmarks = (changed: readonly BookmarkNode[]) => {
    tree = changed;
    for (const listener of bookmarkListeners) listener();
  };
  return {
    stored,
    changeBookmarks,
    moveBookmarks: async (moved: readonly BookmarkNode[]) => {
      changeBookmarks(moved);
      await vi.advanceTimersByTimeAsync(500);
    },
  };
}

function mountPage(): void {
  for (const id of ["wallpaper", "clock", "spotlight-slot", "sidebar", "panel", "announcer"]) {
    const element = document.createElement("div");
    element.id = id;
    document.body.append(element);
  }
}

const sidebarItem = (folderId: string) =>
  document.querySelector<HTMLButtonElement>(`#sidebar [data-key="${folderId}"]`);
const panelTitle = () => document.querySelector("#panel h2")?.textContent;
const resultTitles = () =>
  [...document.querySelectorAll("[role=option]:has(.favicon-tile)")].map(
    (option) => option.querySelector(".spotlight__option-title")?.textContent,
  );

async function start(
  settings: Partial<Settings> = {},
  tree: readonly BookmarkNode[] = SAMPLE_TREE,
) {
  const chromeFake = fakeChrome({ focusSearchOnOpen: false, ...settings }, tree);
  mountPage();
  await startApp(await SettingsStore.load());
  return chromeFake;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const comeBackToTab = () => {
  document.dispatchEvent(new Event("visibilitychange"));
};
const visitElsewhere = (url: string) =>
  chrome.storage.local.set({ usage: { [url]: { score: 3, lastUsed: Date.now() } } });
const panelButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("#panel button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent === name,
  );
const press = (input: HTMLInputElement, key: string) => {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
};

function searchFor(query: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(".spotlight__input");
  if (!input) throw new Error("No search field");
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event("input"));
  return input;
}

function treeWithReadingInsideWork(): BookmarkNode[] {
  const [root] = SAMPLE_TREE;
  const bar = root?.children?.[0];
  const topLevel = bar?.children ?? [];
  const reading = topLevel.find((node) => node.title === "Reading");
  if (!root || !bar || !reading) throw new Error("Unexpected sample tree");
  const children = topLevel
    .filter((node) => node !== reading)
    .map((node) =>
      node.title === "Work" ? { ...node, children: [...(node.children ?? []), reading] } : node,
    );
  return [{ ...root, children: [{ ...bar, children }] }];
}

describe("startApp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    iconWatchers.length = 0;
    appliedBackgrounds.length = 0;
    dialogContexts.length = 0;
    cachedIconOrigins.clear();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("goes back Home when the open folder is moved into another folder", async () => {
    const chromeFake = await start();
    sidebarItem(folderNamed("Reading").id)?.click();
    expect(panelTitle()).toBe("Reading");

    await chromeFake.moveBookmarks(treeWithReadingInsideWork());
    expect(sidebarItem(folderNamed("Reading").id)).toBeNull();
    expect(sidebarItem("home")?.getAttribute("aria-current")).toBe("page");
  });

  it("lets a bookmark be pinned when Home is full only of deleted favourites", async () => {
    const deleted = Array.from({ length: 99 }, (_, index) => `deleted-${index}`);
    await start({ favourites: [...deleted, bookmarkNamed("GitHub").id] });
    const favouriteTitles = [
      ...document.querySelectorAll("#panel [data-favourites] .link-card__title"),
    ].map((title) => title.textContent);
    expect(favouriteTitles).toEqual(["GitHub"]);
    sidebarItem(folderNamed("Work").id)?.click();

    const star = document.querySelector<HTMLButtonElement>("#panel [data-action=toggle-pin]");
    expect(star?.disabled).toBe(false);
    expect(star?.getAttribute("aria-label")).toBe("Pin Jira board to Home");
  });

  it("redraws each icon tile with its own bookmark when two share a URL", async () => {
    const work = {
      id: "10",
      title: "Work",
      children: [
        { id: "11", title: "GitHub", url: "https://github.com/" },
        { id: "12", title: "Code", url: "https://github.com/" },
      ],
    };
    await start({}, [
      { id: "0", title: "", children: [{ id: "1", title: "Bar", children: [work] }] },
    ]);
    sidebarItem(work.id)?.click();

    for (const watcher of iconWatchers) watcher("https://github.com");
    const tileOf = (id: string) =>
      document.querySelector(`#panel .favicon-tile[data-bookmark-id="${id}"]`)?.textContent;
    expect([tileOf("11"), tileOf("12")]).toEqual(["G", "C"]);
  });

  it("updates only the Settings icon counts when an icon arrives", async () => {
    await start();
    const before = { ...dialogRefreshes };
    for (const watcher of iconWatchers) watcher("https://github.com");
    expect(dialogRefreshes).toEqual({ bookmarks: before.bookmarks, icons: before.icons + 1 });
  });

  function treeWithTrailGuide(): BookmarkNode[] {
    const [root] = SAMPLE_TREE;
    const bar = root?.children?.[0];
    if (!root || !bar) throw new Error("Unexpected sample tree");
    const guide = { id: "guide", title: "Trail guide", url: "https://guide.example.com/" };
    return [{ ...root, children: [{ ...bar, children: [...(bar.children ?? []), guide] }] }];
  }

  it("searches the bookmarks as they are after a change", async () => {
    const chromeFake = await start();
    searchFor("trail");
    expect(resultTitles()).toEqual(["Trail map"]);

    await chromeFake.moveBookmarks(treeWithTrailGuide());
    searchFor("trail");
    expect(resultTitles()).toEqual(["Trail guide", "Trail map"]);
  });

  it("picks up a bookmark change made while the page was starting", async () => {
    const chromeFake = fakeChrome({ focusSearchOnOpen: false }, SAMPLE_TREE);
    mountPage();
    const started = startApp(await SettingsStore.load());
    chromeFake.changeBookmarks(treeWithTrailGuide());
    await started;
    await vi.advanceTimersByTimeAsync(500);
    searchFor("trail");
    expect(resultTitles()).toEqual(["Trail guide", "Trail map"]);
  });

  it("updates open search results when labels change", async () => {
    await start();
    searchFor("staging");
    expect(resultTitles()).toEqual([]);

    const staging = {
      id: "staging",
      text: "Staging",
      color: "orange",
      privateNetwork: false,
      hosts: ["*.atlassian.net"],
    } as const;
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, labels: [staging] } });
    await settle();
    expect(resultTitles()).toEqual(["Confluence", "Jira board"]);
  });

  it("counts saved icons only for sites that are still bookmarked", async () => {
    for (const origin of ["https://github.com", "https://trails.example.com"]) {
      cachedIconOrigins.add(origin);
    }
    cachedIconOrigins.add("https://deleted.example.com");
    await start();

    const [context] = dialogContexts;
    expect(context?.siteCounts()).toEqual({ cached: 2, total: 8 });
  });

  it("shows a background that another tab chose while the page was starting", async () => {
    fakeChrome({ focusSearchOnOpen: false }, SAMPLE_TREE);
    mountPage();
    const settings = await SettingsStore.load();
    const chosen = { kind: "photo", photo: "still-lake" } as const;

    const started = startApp(settings);
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, background: chosen } });
    await started;

    expect(appliedBackgrounds).toEqual([DEFAULT_SETTINGS.background, chosen]);
  });

  it("moves keyboard focus to a top-level folder opened from search", async () => {
    await start();
    const input = searchFor("Outdoors");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(document.activeElement?.matches(".panel__title")).toBe(true);
    expect(document.activeElement?.textContent).toBe("Outdoors");
  });

  it("moves keyboard focus into the subfolder section opened from search", async () => {
    await start();
    const input = searchFor("Dashboards");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(panelTitle()).toBe("Work");
    expect(document.activeElement?.matches(".link-card")).toBe(true);
    expect(document.activeElement?.textContent).toContain("IoT Grafana");
  });
  it("keeps a pin made in another tab when pinning here before hearing of it", async () => {
    const chromeFake = await start({ favourites: [bookmarkNamed("GitHub").id] });
    chromeFake.stored.settings = {
      ...DEFAULT_SETTINGS,
      favourites: [bookmarkNamed("GitHub").id, bookmarkNamed("Gear shop").id],
    };
    sidebarItem(folderNamed("Work").id)?.click();
    panelButton("Pin Jira board to Home")?.click();
    await settle();

    expect(chromeFake.stored.settings).toMatchObject({
      favourites: [
        bookmarkNamed("GitHub").id,
        bookmarkNamed("Gear shop").id,
        bookmarkNamed("Jira board").id,
      ],
    });
  });

  it("says where a favourite moved to", async () => {
    await start({ favourites: [bookmarkNamed("GitHub").id, bookmarkNamed("Trail map").id] });
    panelButton("Edit")?.click();
    panelButton("Move GitHub later")?.click();
    await settle();

    expect(document.getElementById("announcer")?.textContent).toBe(
      "GitHub moved to position 2 of 2.",
    );
  });

  it("leaves editing the favourites when going to a folder", async () => {
    await start({ favourites: [bookmarkNamed("GitHub").id, bookmarkNamed("Trail map").id] });
    panelButton("Edit")?.click();
    expect(panelButton("Done")).toBeDefined();

    sidebarItem(folderNamed("Work").id)?.click();
    sidebarItem("home")?.click();
    expect(panelButton("Done")).toBeUndefined();
    expect(panelButton("Edit")).toBeDefined();
  });

  it("shows an empty subfolder opened from search on its own", async () => {
    const [root] = SAMPLE_TREE;
    const bar = root?.children?.[0];
    if (!root || !bar) throw new Error("Unexpected sample tree");
    const archive = { id: "archive", title: "Archive", children: [] };
    const children = (bar.children ?? []).map((node) =>
      node.title === "Work" ? { ...node, children: [...(node.children ?? []), archive] } : node,
    );
    await start({}, [{ ...root, children: [{ ...bar, children }] }]);
    press(searchFor("Archive"), "Enter");

    expect(panelTitle()).toBe("Work › Archive");
    expect(document.querySelector("#panel .panel__empty")?.textContent).toBe(
      "This folder is empty.",
    );
    expect(sidebarItem(folderNamed("Work").id)?.getAttribute("aria-current")).toBe("page");
  });

  it("says how many bookmarks a folder listing leaves out", async () => {
    const archive = {
      id: "archive",
      title: "Archive",
      children: Array.from({ length: 201 }, (_, index) => ({
        id: `a${index}`,
        title: `Acme ${index}`,
        url: `https://a${index}.example.com/`,
      })),
    };
    await start({}, [
      { id: "0", title: "", children: [{ id: "1", title: "Bar", children: [archive] }] },
    ]);
    const input = searchFor("Archive");
    press(input, "Tab");

    expect(document.querySelectorAll("[role=option]:has(.favicon-tile)")).toHaveLength(200);
    expect(document.querySelector("[role=status]")?.textContent).toContain("Showing 200 of 201");
  });

  it("shows visits made in another tab once the page is back in view", async () => {
    await start({ home: { ...DEFAULT_SETTINGS.home, source: "frequent" } });
    expect(document.querySelector("#panel h2, #panel h3")?.textContent).toBe("Recently added");
    const body = document.querySelector("#panel .panel__body");

    await visitElsewhere(bookmarkNamed("Data handbook").url);
    await settle();
    expect(document.querySelector("#panel .panel__body")).toBe(body);

    comeBackToTab();
    expect(document.querySelector("#panel .link-card__title")?.textContent).toBe("Data handbook");
  });

  it("doesn't re-sort Home for a visit made from this tab", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chromeFake = await start({ home: { ...DEFAULT_SETTINGS.home, source: "frequent" } });
    const body = document.querySelector("#panel .panel__body");
    const card = [
      ...document.querySelectorAll<HTMLAnchorElement>("#panel a[data-bookmark-url]"),
    ].at(-1);
    card?.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await settle();
    expect(chromeFake.stored.usage).toHaveProperty([card?.dataset.bookmarkUrl ?? ""]);

    comeBackToTab();
    expect(document.querySelector("#panel .panel__body")).toBe(body);
  });

  it.each([
    ["a folder is open", { source: "frequent" }, true],
    ["Home shows no frequent links", { source: "favourites", showFrequent: false }, false],
  ] as const)(
    "leaves the panel alone for a visit in another tab when %s",
    async (_, home, openWork) => {
      await start({ home: { ...DEFAULT_SETTINGS.home, ...home } });
      if (openWork) sidebarItem(folderNamed("Work").id)?.click();
      const body = document.querySelector("#panel .panel__body");

      await visitElsewhere(bookmarkNamed("Data handbook").url);
      await settle();
      comeBackToTab();
      expect(document.querySelector("#panel .panel__body")).toBe(body);
    },
  );

  it("says so when Home filled up in another tab before a pin here", async () => {
    const links = Array.from({ length: 101 }, (_, index) => ({
      id: `l${index}`,
      title: `Acme ${index}`,
      url: `https://l${index}.example.com/`,
    }));
    const tree = [
      {
        id: "0",
        title: "",
        children: [
          { id: "1", title: "Bar", children: [{ id: "f", title: "Links", children: links }] },
        ],
      },
    ];
    const chromeFake = await start({ favourites: links.slice(0, 99).map((link) => link.id) }, tree);
    chromeFake.stored.settings = {
      ...DEFAULT_SETTINGS,
      favourites: links.slice(0, 100).map((link) => link.id),
    };
    sidebarItem("f")?.click();
    panelButton("Pin Acme 100 to Home")?.click();
    await settle();

    expect(document.getElementById("announcer")?.textContent).toBe("Favourites are full.");
  });

  it("shows the dynamic wallpaper the service worker found while the page was starting", async () => {
    fakeChrome({ focusSearchOnOpen: false }, SAMPLE_TREE);
    mountPage();
    const started = startApp(await SettingsStore.load());
    await chrome.storage.local.set({ wallpaperInstalled: true });
    await started;

    expect(appliedBackgrounds).toEqual([DEFAULT_SETTINGS.background, DEFAULT_SETTINGS.background]);
  });

  it("keeps a chosen photo when the service worker finds a dynamic wallpaper", async () => {
    await start({ background: { kind: "photo", photo: "still-lake" } });
    await chrome.storage.local.set({ wallpaperInstalled: true });
    expect(appliedBackgrounds).toEqual([{ kind: "photo", photo: "still-lake" }]);
  });

  it("shows the dynamic wallpaper once the service worker finds it", async () => {
    await start();
    expect(appliedBackgrounds).toEqual([DEFAULT_SETTINGS.background]);

    await chrome.storage.local.set({ wallpaperInstalled: true });
    expect(appliedBackgrounds).toEqual([DEFAULT_SETTINGS.background, DEFAULT_SETTINGS.background]);
  });

  it("leaves the page alone for a settings change it doesn't show", async () => {
    await start();
    const panel = document.querySelector("#panel .panel__body");
    await chrome.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, focusSearchOnOpen: true },
    });
    await settle();
    expect(document.querySelector("#panel .panel__body")).toBe(panel);
  });
});
