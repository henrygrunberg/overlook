import type { Page } from "@playwright/test";
import { expect, pin, seedBookmarks, test, type SeedNode } from "./fixtures.ts";

const favouriteTitles = (page: Page) =>
  page.locator("[data-favourites] .link-card__title").allTextContents();

test.describe("favourites", () => {
  test("pins bookmarks to Home in the order they were pinned", async ({ newTab }) => {
    await pin(newTab, /^Outdoors/, "Trail map");
    await pin(newTab, /^Work/, "Jira board");
    await newTab.getByRole("button", { name: "Home", exact: true }).click();

    const panel = newTab.getByRole("main");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Favourites");
    expect(await favouriteTitles(newTab)).toEqual(["Trail map", "Jira board"]);
    // Pinned bookmarks don't show up again under Recently added.
    await expect(panel.getByRole("link", { name: /Trail map/ })).toHaveCount(1);

    await newTab.reload();
    await expect.poll(() => favouriteTitles(newTab)).toEqual(["Trail map", "Jira board"]);
  });

  test("reorders and unpins favourites while editing", async ({ newTab }) => {
    await pin(newTab, /^Outdoors/, "Trail map");
    await pin(newTab, /^Outdoors/, "Gear shop");
    await pin(newTab, /^Work/, "Jira board");
    await newTab.getByRole("button", { name: "Home", exact: true }).click();

    await newTab.getByRole("button", { name: "Edit" }).click();
    await newTab.getByRole("button", { name: "Move Jira board earlier" }).click();
    await expect
      .poll(() => favouriteTitles(newTab))
      .toEqual(["Trail map", "Jira board", "Gear shop"]);
    await expect(newTab.getByRole("button", { name: "Move Jira board earlier" })).toBeFocused();

    await newTab
      .locator("[data-favourites] .link-card-wrap")
      .nth(2)
      .dragTo(newTab.locator("[data-favourites] .link-card-wrap").first());
    await expect
      .poll(() => favouriteTitles(newTab))
      .toEqual(["Gear shop", "Trail map", "Jira board"]);

    // Clicking a favourite while editing doesn't open it; the panel cancels the link's click.
    await newTab.evaluate(() => {
      window.addEventListener("click", (event) => {
        document.body.dataset.lastClickPrevented = String(event.defaultPrevented);
      });
    });
    await newTab
      .locator("[data-favourites]")
      .getByRole("link", { name: /Trail map/ })
      .click();
    await expect(newTab.locator("body")).toHaveAttribute("data-last-click-prevented", "true");
    await expect(newTab).toHaveURL(/newtab\.html/);

    // Unpinning removes the focused button; focus moves to Done instead of getting lost.
    await newTab.getByRole("button", { name: "Unpin Trail map" }).focus();
    await newTab.keyboard.press("Enter");
    await expect.poll(() => favouriteTitles(newTab)).toEqual(["Gear shop", "Jira board"]);
    await expect(newTab.getByRole("button", { name: "Done" })).toBeFocused();
    await newTab.getByRole("button", { name: "Done" }).click();
    await expect(newTab.getByRole("button", { name: "Edit" })).toBeVisible();
  });
});

test.describe("favourites when a pinned bookmark is deleted", () => {
  test("keeps editing the rest", async ({ newTab }) => {
    await pin(newTab, /^Outdoors/, "Trail map");
    await pin(newTab, /^Outdoors/, "Gear shop");
    await pin(newTab, /^Work/, "Jira board");
    await newTab.getByRole("button", { name: "Home", exact: true }).click();
    await newTab.getByRole("button", { name: "Edit" }).click();

    await newTab.evaluate(async () => {
      const [gearShop] = await chrome.bookmarks.search({ title: "Gear shop" });
      if (gearShop) await chrome.bookmarks.remove(gearShop.id);
    });
    await expect.poll(() => favouriteTitles(newTab)).toEqual(["Trail map", "Jira board"]);
    await expect(newTab.getByRole("button", { name: "Done" })).toBeVisible();

    await newTab.getByRole("button", { name: "Move Jira board earlier" }).click();
    await expect.poll(() => favouriteTitles(newTab)).toEqual(["Jira board", "Trail map"]);
    await newTab.getByRole("button", { name: "Unpin Trail map" }).click();
    await newTab.getByRole("button", { name: "Unpin Jira board" }).click();
    await expect(newTab.locator("[data-favourites] .link-card")).toHaveCount(0);
    await expect(newTab.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(newTab.getByRole("button", { name: "Done" })).toHaveCount(0);
  });
});

test.describe("favourites while scrolled", () => {
  test("pinning keeps the panel where it was scrolled to", async ({ newTab }) => {
    await seedBookmarks(newTab, [
      {
        title: "Articles",
        children: Array.from({ length: 40 }, (_, index) => ({
          title: `Article ${index + 1}`,
          url: `https://read${index}.example.com/`,
        })),
      },
    ]);
    await newTab.getByRole("button", { name: /^Articles/ }).click();
    const body = newTab.locator(".panel__body");
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const scrolled = await body.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);

    await newTab.getByRole("link", { name: /Article 40/ }).hover();
    await newTab.getByRole("button", { name: "Pin Article 40 to Home" }).click();
    await expect(newTab.getByRole("button", { name: "Unpin Article 40 from Home" })).toBeVisible();
    expect(await body.evaluate((element) => element.scrollTop)).toBe(scrolled);
  });
});

test.describe("layout", () => {
  const manyFolders: SeedNode[] = Array.from({ length: 15 }, (_, index) => ({
    title: `Project ${String(index + 1).padStart(2, "0")}`,
    children: Array.from({ length: 6 }, (__, link) => ({
      title: `Link ${link + 1}`,
      url: `https://p${index}-${link}.example.com/`,
    })),
  }));

  test("never scrolls the page; the folder list scrolls instead", async ({ newTab }) => {
    await seedBookmarks(newTab, manyFolders);
    await expect(newTab.getByRole("button", { name: /^Project 15/ })).toBeAttached();

    const page = await newTab.evaluate(() => ({
      scroll: document.scrollingElement?.scrollHeight ?? 0,
      height: window.innerHeight,
    }));
    expect(page.scroll).toBeLessThanOrEqual(page.height);

    const folders = newTab.locator(".sidebar__folders");
    await expect(folders).toHaveClass(/has-more-below/);
    const more = newTab.locator(".sidebar__more");
    await expect(more).toHaveText(/^\d+ more folders?$/);

    await more.click();
    await expect(folders).toHaveClass(/has-more-above/);
    await newTab.getByRole("button", { name: /^Project 15/ }).click();
    await expect(newTab.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(
      "Project 15",
    );
  });
});
