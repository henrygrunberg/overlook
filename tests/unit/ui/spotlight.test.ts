import { describe, expect, it, vi } from "vitest";
import type { Folder } from "../../../src/bookmarks/library";
import type { SearchResults } from "../../../src/search/search-index";
import { bookmarkNamed, folderNamed } from "../fixtures/sample-library";
import { h } from "../../../src/ui/dom";
import { Spotlight, type SpotlightDeps, type SpotlightResults } from "../../../src/ui/spotlight";

function mountSpotlight(
  results: SearchResults | (() => SpotlightResults),
  overrides: Partial<SpotlightDeps> = {},
) {
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://overlook-test${path}` },
  });
  const spotlight = new Spotlight({
    search: typeof results === "function" ? results : () => results,
    colorOf: () => "#0a84ff",
    decorate: () => ({
      color: "#0a84ff",
      labels: [],
      icons: { iconFor: () => ({ kind: "none" }) },
      pinned: false,
      canPin: true,
    }),
    onOpenFolder: () => undefined,
    onOpenBookmark: () => undefined,
    onSearchWeb: () => undefined,
    ...overrides,
  });
  const panelTitle = h("h2", { className: "panel__title", attributes: { tabindex: "-1" } });
  document.body.replaceChildren(spotlight.element, panelTitle);
  const input = spotlight.element.querySelector("input");
  if (!input) throw new Error("No search input");
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input"));
  };
  const keyDown = (key: string, init: KeyboardEventInit = {}) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));
  };
  spotlight.focus();
  const selected = () =>
    spotlight.element.querySelector("[aria-selected=true] .spotlight__option-title")?.textContent;
  return { spotlight, element: spotlight.element, input, type, keyDown, selected, panelTitle };
}

const hit = <T>(item: T, score = 1) => ({ item, score });

describe("Spotlight", () => {
  it("names the folder a search is scoped to", () => {
    const dashboards: Folder = folderNamed("Dashboards");
    const { element, input, type, keyDown } = mountSpotlight({
      folders: [hit(dashboards)],
      bookmarks: [],
    });
    type("dash");
    keyDown("Tab");

    const chip = element.querySelector(".spotlight__scope");
    expect(input.getAttribute("aria-label")).toBe("Search in Dashboards");
    expect(chip?.getAttribute("aria-label")).toBe("Remove folder filter Work › Dashboards");
    expect(chip?.getAttribute("title")).toBe("Work › Dashboards");

    keyDown("Backspace");
    expect(input.getAttribute("aria-label")).toBe("Search bookmarks, folders or the web");
  });

  it("stays in the folder while a held Backspace clears the search", () => {
    const { input, type, keyDown } = mountSpotlight({
      folders: [hit(folderNamed("Dashboards"))],
      bookmarks: [],
    });
    type("dash");
    keyDown("Tab");
    keyDown("Backspace", { repeat: true });
    expect(input.getAttribute("aria-label")).toBe("Search in Dashboards");
  });

  it("opens a background tab once while Ctrl+Enter is held", () => {
    const opened = vi.fn();
    const { type, keyDown } = mountSpotlight(
      { folders: [], bookmarks: [hit(bookmarkNamed("GitHub"))] },
      { onOpenBookmark: opened },
    );
    type("git");
    keyDown("Enter", { ctrlKey: true });
    keyDown("Enter", { ctrlKey: true, repeat: true });
    keyDown("Enter", { ctrlKey: true, repeat: true });
    expect(opened).toHaveBeenCalledExactlyOnceWith(expect.anything(), "background-tab");
  });

  it.each([
    ["click", { ctrlKey: true }],
    ["auxclick", { button: 1 }],
  ])("opens a result once on a background-tab double %s", (type, init) => {
    const opened = vi.fn();
    const { element, type: search } = mountSpotlight(
      { folders: [], bookmarks: [hit(bookmarkNamed("GitHub"))] },
      { onOpenBookmark: opened },
    );
    search("git");
    const option = element.querySelector("[role=option]");
    for (const detail of [1, 2]) {
      option?.dispatchEvent(new MouseEvent(type, { bubbles: true, detail, ...init }));
    }
    expect(opened).toHaveBeenCalledExactlyOnceWith(expect.anything(), "background-tab");
  });

  it("keeps key hints out of option names and announces the results", () => {
    const { element, type } = mountSpotlight({
      folders: [hit(folderNamed("Work"))],
      bookmarks: [hit(bookmarkNamed("GitHub")), hit(bookmarkNamed("Confluence"))],
    });
    type("g");

    for (const hint of element.querySelectorAll(".spotlight__option-hint")) {
      expect(hint.getAttribute("aria-hidden")).toBe("true");
    }
    expect(element.querySelector(".spotlight__footer")?.getAttribute("aria-hidden")).toBe("true");
    expect(element.querySelector("[role=status]")?.textContent).toBe("1 folder, 2 bookmarks");
  });

  it("shows the empty message outside the listbox", () => {
    const { element, type } = mountSpotlight({ folders: [], bookmarks: [] });
    type("nothing");

    const empty = element.querySelector<HTMLElement>(".spotlight__empty");
    expect(empty?.hidden).toBe(false);
    expect(empty?.closest("[role=listbox]")).toBeNull();
    expect(empty?.textContent).toBe("No bookmarks match.");
    expect(element.querySelector("[role=status]")?.textContent).toBe("No bookmarks or folders");
    expect(element.querySelectorAll("[role=listbox] [role=option]")).toHaveLength(1);
  });

  it("groups the options as folders, bookmarks and the web search, in option order", () => {
    const { element, type } = mountSpotlight({
      folders: [hit(folderNamed("Work"))],
      bookmarks: [hit(bookmarkNamed("GitHub")), hit(bookmarkNamed("Confluence"))],
    });
    type("g");

    const groups = [...element.querySelectorAll("[role=group]")].map((group) => ({
      label: document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
      options: [...group.querySelectorAll("[role=option]")].map((option) => option.id),
    }));
    expect(groups).toEqual([
      { label: "Folders", options: ["spotlight-option-0"] },
      { label: "Bookmarks", options: ["spotlight-option-1", "spotlight-option-2"] },
      { label: "Web", options: ["spotlight-option-3"] },
    ]);
  });

  it("scrolls to the active option on arrow keys, but not when the pointer hovers one", () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { element, type, keyDown } = mountSpotlight({
      folders: [],
      bookmarks: [hit(bookmarkNamed("GitHub")), hit(bookmarkNamed("Confluence"))],
    });
    type("g");
    const options = [...element.querySelectorAll("[role=option]")];
    scrolled.mockClear();

    options[2]?.dispatchEvent(new PointerEvent("pointermove"));
    expect(options[2]?.getAttribute("aria-selected")).toBe("true");
    expect(scrolled).not.toHaveBeenCalled();

    keyDown("ArrowUp");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toHaveBeenCalledOnce();
  });

  it("shows the background-tab shortcut for the platform", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const { element } = mountSpotlight({ folders: [], bookmarks: [] });
    expect(element.querySelector(".spotlight__footer")?.textContent).toContain(
      "Ctrl ↵ background tab",
    );
  });

  it("opens the best match on Enter, even when a weaker folder match is listed first", () => {
    const opened = vi.fn();
    const openedFolder = vi.fn();
    const { type, keyDown, selected } = mountSpotlight(
      {
        folders: [hit(folderNamed("Reading"), 0.15)],
        bookmarks: [hit(bookmarkNamed("Data handbook"), 1.1)],
      },
      { onOpenBookmark: opened, onOpenFolder: openedFolder },
    );
    type("data");
    expect(selected()).toBe("Data handbook");
    keyDown("Enter");
    expect(opened).toHaveBeenCalledWith(bookmarkNamed("Data handbook"), "current-tab");
    expect(openedFolder).not.toHaveBeenCalled();
  });

  it("selects the folder when it matches as well as the best bookmark", () => {
    const { type, selected } = mountSpotlight({
      folders: [hit(folderNamed("Dashboards"), 0.9)],
      bookmarks: [hit(bookmarkNamed("IoT Grafana"), 0.9)],
    });
    type("dash");
    expect(selected()).toBe("Dashboards");
  });

  it("keeps the selection in a folder search when the bookmarks change", () => {
    const work = folderNamed("Work");
    const { spotlight, type, keyDown, selected } = mountSpotlight(() => ({
      folders: [hit(work)],
      bookmarks: work.bookmarks.map((bookmark) => hit(bookmark)),
    }));
    type("work");
    keyDown("Tab");
    keyDown("ArrowDown");
    keyDown("ArrowDown");
    expect(selected()).toBe("Confluence");

    spotlight.refresh(() => work);
    expect(selected()).toBe("Confluence");
  });

  it("opens the results before scrolling to the first one, so they come into view", () => {
    const { element, type } = mountSpotlight({
      folders: [],
      bookmarks: [hit(bookmarkNamed("GitHub"))],
    });
    const popover = element.querySelector<HTMLElement>(".spotlight__popover");
    const hiddenWhenScrolled: unknown[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {
      hiddenWhenScrolled.push(popover?.hidden);
    });
    type("g");
    expect(hiddenWhenScrolled).toEqual([false, false]);
  });

  it("shows a group's heading when the selection wraps round to its first option", () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { element, type, keyDown } = mountSpotlight({
      folders: [],
      bookmarks: [hit(bookmarkNamed("GitHub")), hit(bookmarkNamed("Confluence"))],
    });
    type("g");
    keyDown("ArrowUp");
    scrolled.mockClear();

    keyDown("ArrowDown");
    const heading = element.querySelector(".spotlight__group-label");
    expect(scrolled.mock.contexts).toEqual([heading, element.querySelector("[role=option]")]);
  });

  it("moves focus to the panel title, not the page, on Escape in an empty field", () => {
    const { input, keyDown, type, panelTitle } = mountSpotlight({ folders: [], bookmarks: [] });
    type("trail");
    keyDown("Escape");
    expect(document.activeElement).toBe(input);

    keyDown("Escape");
    expect(document.activeElement).toBe(panelTitle);
  });

  it("tells screen readers that Tab searches inside a folder", () => {
    const { element, type } = mountSpotlight({
      folders: [hit(folderNamed("Work"))],
      bookmarks: [],
    });
    type("work");
    const folderOption = element.querySelector("[role=option]");
    const spokenText = [...(folderOption?.querySelectorAll("*") ?? [])]
      .filter((node) => !node.closest("[aria-hidden=true]") && node.children.length === 0)
      .map((node) => node.textContent)
      .join(" ");
    expect(spokenText).toContain("press Tab to search inside");
  });

  it("says when a folder lists only some of its bookmarks", () => {
    const work = folderNamed("Work");
    const { element, type, keyDown } = mountSpotlight(() => ({
      folders: [hit(work)],
      bookmarks: work.bookmarks.map((bookmark) => hit(bookmark)),
      total: 350,
    }));
    type("work");
    keyDown("Tab");
    const note = element.querySelector<HTMLElement>(".spotlight__empty");
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toBe("Showing 2 of 350 bookmarks. Type to narrow them down.");
    expect(element.querySelector("[role=status]")?.textContent).toBe("Showing 2 of 350 bookmarks");
  });

  it("says Escape clears a search typed in a folder, and closes otherwise", () => {
    const { element, type, keyDown } = mountSpotlight({
      folders: [hit(folderNamed("Work"))],
      bookmarks: [],
    });
    const escapeHint = () =>
      element.querySelector(".spotlight__footer")?.lastElementChild?.textContent;
    type("work");
    expect(escapeHint()).toBe("esc close");
    keyDown("Tab");
    expect(escapeHint()).toBe("esc close");
    type("j");
    expect(escapeHint()).toBe("esc clear");
  });

  it("keeps the label chips out of the clipped path and lets titles pick their direction", () => {
    const { element, type } = mountSpotlight({
      folders: [],
      bookmarks: [hit(bookmarkNamed("IoT Grafana"))],
    });
    type("iot");
    const detail = element.querySelector(".spotlight__option-detail");
    expect(detail?.querySelector(".spotlight__option-path")?.textContent).toBe(
      "Work › Dashboards · 10.0.0.20",
    );
    expect(detail?.querySelector(".spotlight__option-path .chips")).toBeNull();
    for (const text of element.querySelectorAll(
      ".spotlight__option-title, .spotlight__option-path",
    )) {
      expect(text.getAttribute("dir")).toBe("auto");
    }
  });
});
