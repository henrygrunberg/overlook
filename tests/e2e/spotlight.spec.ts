import { expect, seedBookmarks, test } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const searchBox = (page: Page) => page.getByRole("combobox");
const options = (page: Page) => page.getByRole("option");

test.describe("Spotlight search", () => {
  test("focuses when you start typing anywhere", async ({ newTab }) => {
    await newTab.locator("body").click({ position: { x: 5, y: 5 } });
    await newTab.keyboard.type("trai");

    await expect(searchBox(newTab)).toBeFocused();
    await expect(searchBox(newTab)).toHaveValue("trai");
    await expect(options(newTab).first()).toContainText("Trail map");
  });

  test("groups folders, bookmarks and a web search", async ({ newTab }) => {
    await searchBox(newTab).fill("dash");
    const groups = newTab.getByRole("group");

    await expect(groups.getByRole("option").first()).toContainText("Dashboards");
    await expect(groups.nth(0)).toHaveAccessibleName("Folders");
    await expect(groups.nth(1)).toHaveAccessibleName("Bookmarks");
    await expect(groups.nth(2)).toHaveAccessibleName("Web");
    await expect(options(newTab).last()).toContainText("Search the web for “dash”");
  });

  test("moves the selection with the arrow keys", async ({ newTab }) => {
    const box = searchBox(newTab);
    await box.fill("grafana");
    await expect(box).toHaveAttribute("aria-expanded", "true");
    await expect(options(newTab).nth(0)).toHaveAttribute("aria-selected", "true");

    await box.press("ArrowDown");
    await expect(options(newTab).nth(1)).toHaveAttribute("aria-selected", "true");
    const activeId = await options(newTab).nth(1).getAttribute("id");
    await expect(box).toHaveAttribute("aria-activedescendant", activeId ?? "");

    await box.press("ArrowUp");
    await box.press("ArrowUp");
    await expect(options(newTab).last()).toHaveAttribute("aria-selected", "true");
  });

  test("opens the selected bookmark with Enter", async ({ newTab }) => {
    await searchBox(newTab).fill("gear shop");
    await searchBox(newTab).press("Enter");
    await expect(newTab).toHaveURL("https://gear.example.com/");
  });

  test("opens a background tab with ⌘/Ctrl-Enter", async ({ newTab }) => {
    await searchBox(newTab).fill("gear shop");
    await searchBox(newTab).press("ControlOrMeta+Enter");

    await expect
      .poll(() =>
        newTab.evaluate(async () =>
          (await chrome.tabs.query({}))
            .filter((tab) => (tab.pendingUrl ?? tab.url)?.startsWith("https://gear.example.com"))
            .map((tab) => tab.active),
        ),
      )
      .toEqual([false]);
    await expect(searchBox(newTab)).toHaveValue("gear shop");
  });

  const doubleClicks: [string, Parameters<Locator["dblclick"]>[0]][] = [
    ["⌘/Ctrl-double-click", { modifiers: ["ControlOrMeta"] }],
    ["middle double-click", { button: "middle" }],
  ];
  for (const [gesture, clickOptions] of doubleClicks) {
    test(`opens one background tab on a ${gesture}`, async ({ newTab }) => {
      const tabsOpening = (prefix: string) =>
        newTab.evaluate(
          async (prefix) =>
            (await chrome.tabs.query({})).filter((tab) =>
              (tab.pendingUrl ?? tab.url)?.startsWith(prefix),
            ).length,
          prefix,
        );
      await searchBox(newTab).fill("gear shop");
      await newTab.getByRole("option", { name: /Gear shop/ }).dblclick(clickOptions);
      // Opened after both clicks were handled, so once it shows, a second gear tab would have too.
      await searchBox(newTab).fill("trail map");
      await searchBox(newTab).press("ControlOrMeta+Enter");
      await expect.poll(() => tabsOpening("https://trails.example.com")).toBe(1);

      expect(await tabsOpening("https://gear.example.com")).toBe(1);
    });
  }

  test("narrows the search to a folder with Tab and leaves it with Backspace", async ({
    newTab,
  }) => {
    const box = searchBox(newTab);
    await box.fill("dash");
    await box.press("Tab");

    const scope = newTab.getByRole("button", { name: /^Remove folder filter/ });
    await expect(scope).toHaveText("Work › Dashboards");
    await expect(box).toHaveValue("");
    await expect(options(newTab)).toHaveText([/IoT Grafana/, /Load testing Grafana/]);

    await box.fill("load");
    await expect(options(newTab)).toHaveText([/Load testing Grafana/, /Search the web/]);

    await box.fill("");
    await box.press("Backspace");
    await expect(scope).toBeHidden();
  });

  test("leaves a folder scope when that folder is deleted", async ({ newTab }) => {
    const box = searchBox(newTab);
    await box.fill("dash");
    await box.press("Tab");
    const scope = newTab.getByRole("button", { name: /^Remove folder filter/ });
    await expect(scope).toHaveText("Work › Dashboards");

    await newTab.evaluate(async () => {
      const [dashboards] = await chrome.bookmarks.search({ title: "Dashboards" });
      if (dashboards) await chrome.bookmarks.removeTree(dashboards.id);
    });
    await expect(scope).toBeHidden();
    await box.fill("jira");
    await expect(options(newTab).first()).toContainText("Jira board");
  });

  test("opens a folder in the panel with Enter", async ({ newTab }) => {
    await searchBox(newTab).fill("dashboards");
    await searchBox(newTab).press("Enter");

    const panel = newTab.getByRole("main");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Work");
    await expect(newTab.getByRole("button", { name: /^Work/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(searchBox(newTab)).toHaveValue("");
  });

  test("searches the web with the default engine when nothing matches", async ({ newTab }) => {
    await newTab.locator("body").click({ position: { x: 5, y: 5 } });
    await newTab.keyboard.type("weather tomorrow");
    await expect(
      newTab.getByRole("paragraph").filter({ hasText: "No bookmarks match." }),
    ).toBeVisible();
    await expect(options(newTab)).toHaveText([/Search the web for “weather tomorrow”/]);

    await newTab.keyboard.press("Enter");
    await expect(newTab).toHaveURL(/[?&]q=weather(\+|%20)tomorrow/);
  });

  test("clears, then closes with Escape", async ({ newTab }) => {
    const box = searchBox(newTab);
    await box.fill("trail");
    await box.press("Escape");
    await expect(box).toHaveValue("");
    await expect(box).toHaveAttribute("aria-expanded", "false");

    await box.press("Escape");
    await expect(box).not.toBeFocused();
  });

  test("never renders bookmark titles as HTML", async ({ newTab }) => {
    await newTab.evaluate(() =>
      chrome.bookmarks.create({
        parentId: "1",
        title: '<img src=x onerror="document.title=`pwned`">Evil',
        url: "https://evil.example/",
      }),
    );
    await searchBox(newTab).fill("evil");
    await expect(options(newTab).first()).toContainText("<img src=x");
    await expect(newTab.locator(".spotlight img[src='x']")).toHaveCount(0);
    expect(await newTab.title()).toBe("New Tab");
  });

  test("opens an exact bookmark match with Enter, not a folder that matches less well", async ({
    newTab,
  }) => {
    await seedBookmarks(newTab, [
      { title: "News", url: "https://news.example.com/" },
      {
        title: "Networks & Systems",
        children: [{ title: "Router", url: "https://router.example.com/" }],
      },
    ]);
    const box = searchBox(newTab);
    await box.fill("news");
    await expect(options(newTab)).toContainText(["Networks & Systems", "News"]);
    await expect(newTab.getByRole("option", { selected: true })).toContainText("News");
    await box.press("Enter");
    await expect(newTab).toHaveURL("https://news.example.com/");
  });

  test("brings the first results into view in a short window", async ({ newTab }) => {
    await newTab.setViewportSize({ width: 320, height: 256 });
    await searchBox(newTab).focus();
    await newTab.keyboard.type("g");
    const selected = newTab.getByRole("option", { selected: true });
    await expect(selected).toBeVisible();
    const { bottom, height } = await selected.evaluate((option) => ({
      bottom: option.getBoundingClientRect().bottom,
      height: window.innerHeight,
    }));
    // Scrolling lands on whole pixels, so the row can end a fraction below the window.
    expect(bottom).toBeLessThan(height + 1);
  });

  test("leaves the field for the panel's title, never the page, on Escape", async ({ newTab }) => {
    await newTab.locator("body").click({ position: { x: 5, y: 5 } });
    await newTab.keyboard.press("/");
    await expect(searchBox(newTab)).toBeFocused();
    await newTab.keyboard.press("Escape");
    await expect(newTab.locator(".panel__title")).toBeFocused();

    await newTab.keyboard.press(",");
    await expect(newTab.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  test("shows the group's heading again when the selection wraps round", async ({ newTab }) => {
    await seedBookmarks(
      newTab,
      Array.from({ length: 12 }, (_, index) => ({
        title: `Acme item ${index + 1}`,
        url: `https://item${index + 1}.example.com/`,
      })),
    );
    await newTab.setViewportSize({ width: 1440, height: 500 });
    const box = searchBox(newTab);
    await box.fill("acme");
    await expect(options(newTab)).not.toHaveCount(0);
    const last = options(newTab).last();
    for (let step = 0; (await last.getAttribute("aria-selected")) !== "true"; step++) {
      expect(step).toBeLessThan(50);
      await box.press("ArrowDown");
    }
    await box.press("ArrowDown");
    await expect(options(newTab).first()).toHaveAttribute("aria-selected", "true");
    expect(await newTab.locator(".spotlight__listbox").evaluate((list) => list.scrollTop)).toBe(0);
  });

  test("opens an empty subfolder as its own view", async ({ newTab }) => {
    await newTab.evaluate(async () => {
      const [work] = await chrome.bookmarks.search({ title: "Work" });
      if (work) await chrome.bookmarks.create({ parentId: work.id, title: "Archive" });
    });
    await searchBox(newTab).fill("archive");
    await expect(options(newTab).first()).toContainText("Archive");
    await searchBox(newTab).press("Enter");

    const panel = newTab.getByRole("main");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Work › Archive");
    await expect(panel.getByText("This folder is empty.")).toBeVisible();
  });

  test("keeps a label chip in view on a search result with a long path", async ({ newTab }) => {
    await newTab.setViewportSize({ width: 320, height: 700 });
    await searchBox(newTab).fill("grafana");
    const rows = newTab.locator(".spotlight__option:has(.chip)");
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      const fits = await row.evaluate((option) => {
        const chip = option.querySelector(".chip")?.getBoundingClientRect();
        const detail = option.querySelector(".spotlight__option-detail")?.getBoundingClientRect();
        return chip !== undefined && detail !== undefined && chip.right <= detail.right;
      });
      expect(fits).toBe(true);
    }
  });
});
