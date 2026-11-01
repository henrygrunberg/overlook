import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl, searchWeb, shortcutModifier, type Disposition } from "../../../src/ui/navigation";

describe("shortcutModifier", () => {
  it.each([
    ["MacIntel", "⌘"],
    ["iPad", "⌘"],
    ["Win32", "Ctrl"],
    ["Linux x86_64", "Ctrl"],
  ])("on %s is %s", (platform, modifier) => {
    expect(shortcutModifier(platform)).toBe(modifier);
  });
});

describe("openUrl", () => {
  const URL_OPENED = "https://example.com/";
  const page = { id: 7, index: 2, windowId: 1, groupId: 3 };
  const update = vi.fn(() => Promise.resolve());
  const create = vi.fn(() => Promise.resolve({ id: 20 }));
  const group = vi.fn(() => Promise.resolve(3));

  function stubTabs(current: object | undefined, inWindow: readonly object[] = []) {
    vi.stubGlobal("chrome", {
      tabs: {
        getCurrent: () => Promise.resolve(current),
        query: () => Promise.resolve(inWindow),
        update,
        create,
        group,
      },
    });
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("navigates this page's own tab, even if another tab has come to the front", async () => {
    stubTabs(page);
    await openUrl(URL_OPENED, "current-tab");
    expect(update).toHaveBeenCalledExactlyOnceWith(7, { url: URL_OPENED });
  });

  it("opens a background tab after the ones this page opened, in its tab group", async () => {
    stubTabs(page, [page, { id: 11, index: 3, openerTabId: 7 }, { id: 12, index: 4 }]);
    await openUrl(URL_OPENED, "background-tab");
    expect(create).toHaveBeenCalledExactlyOnceWith({
      url: URL_OPENED,
      active: false,
      index: 4,
      openerTabId: 7,
    });
    expect(group).toHaveBeenCalledExactlyOnceWith({ groupId: 3, tabIds: 20 });
  });

  it("leaves a background tab ungrouped when this tab is in no group", async () => {
    stubTabs({ ...page, groupId: -1 }, [page]);
    await openUrl(URL_OPENED, "background-tab");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }));
    expect(group).not.toHaveBeenCalled();
  });
});

describe("searchWeb", () => {
  it.each<[Disposition, string]>([
    ["current-tab", "CURRENT_TAB"],
    ["background-tab", "NEW_TAB"],
  ])("searches in the %s with the %s disposition", async (disposition, expected) => {
    const query = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", { search: { query } });
    await searchWeb("weather", disposition);
    expect(query).toHaveBeenCalledExactlyOnceWith({ text: "weather", disposition: expected });
  });
});
