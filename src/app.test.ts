import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp } from "./app";
import type { BookmarkNode } from "./bookmarks/library";
import { DEFAULT_SETTINGS, type BackgroundChoice, type Settings } from "./settings/settings";
import { SettingsStore } from "./settings/settings-store";
import { SAMPLE_TREE, bookmarkNamed, folderNamed } from "./test/sample-library";
import type { SettingsContext } from "./ui/settings-dialog";

const appliedBackgrounds = vi.hoisted(() => [] as BackgroundChoice[]);
vi.mock("./ui/background-view", () => ({
  BackgroundView: class {
    apply(choice: BackgroundChoice) {
      appliedBackgrounds.push(choice);
      return Promise.resolve();
    }
  },
}));
const dialogContexts = vi.hoisted(() => [] as SettingsContext[]);
vi.mock("./ui/settings-dialog", () => ({
  SettingsDialog: class {
    constructor(_settings: unknown, context: SettingsContext) {
      dialogContexts.push(context);
    }
    open() {
      return Promise.resolve();
    }
  },
}));
const iconWatchers = vi.hoisted(() => [] as ((origin: string) => void)[]);
const cachedIconOrigins = vi.hoisted(() => new Set<string>());
vi.mock("./favicons/icon-library", () => ({
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
  let stored: unknown = { ...DEFAULT_SETTINGS, ...settings };
  const bookmarkListeners: Listener[] = [];
  const storageListeners: Listener[] = [];
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
        get: (key: string) => Promise.resolve(key === "settings" ? { settings: stored } : {}),
        set: (items: Record<string, unknown>) => {
          if ("settings" in items) {
            stored = items.settings;
            for (const listener of storageListeners) {
              listener({ settings: { newValue: stored } }, "local");
            }
          }
          return Promise.resolve();
        },
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
    changeBookmarks,
    moveBookmarks: async (moved: readonly BookmarkNode[]) => {
      changeBookmarks(moved);
      await vi.advanceTimersByTimeAsync(500);
    },
  };
}

function mountPage(): void {
  for (const id of ["wallpaper", "clock", "spotlight-slot", "sidebar", "panel"]) {
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
    expect(resultTitles()).toEqual(["Confluence", "Jira board"]);
  });

  it("counts saved icons only for sites that are still bookmarked", async () => {
    for (const origin of ["https://github.com", "https://trails.example.com"]) {
      cachedIconOrigins.add(origin);
    }
    cachedIconOrigins.add("https://deleted.example.com");
    await start();

    const [context] = dialogContexts;
    expect(context?.cachedSites()).toBe(2);
    expect(context?.totalSites()).toBe(8);
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
});
