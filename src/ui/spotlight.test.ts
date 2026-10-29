import { afterEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "../bookmarks/library";
import type { SearchResults } from "../search/search-index";
import { bookmarkNamed, folderNamed } from "../test/sample-library";
import { Spotlight, type SpotlightDeps } from "./spotlight";

function mountSpotlight(
  results: SearchResults,
  onOpenBookmark: SpotlightDeps["onOpenBookmark"] = () => undefined,
) {
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://overlook-test${path}` },
  });
  const spotlight = new Spotlight({
    search: () => results,
    colorOf: () => "#0a84ff",
    decorate: () => ({
      color: "#0a84ff",
      labels: [],
      icons: { iconFor: () => ({ kind: "none" }) },
      pinned: false,
      canPin: true,
    }),
    onOpenFolder: () => undefined,
    onOpenBookmark,
    onSearchWeb: () => undefined,
  });
  document.body.replaceChildren(spotlight.element);
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
  return { element: spotlight.element, input, type, keyDown };
}

const hit = <T>(item: T) => ({ item, score: 1 });

afterEach(() => {
  vi.restoreAllMocks();
});

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
      opened,
    );
    type("git");
    keyDown("Enter", { ctrlKey: true });
    keyDown("Enter", { ctrlKey: true, repeat: true });
    keyDown("Enter", { ctrlKey: true, repeat: true });
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
});
