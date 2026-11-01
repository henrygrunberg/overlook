import type { Page } from "@playwright/test";
import { expect, seedBookmarks, test } from "./fixtures.ts";

// Warnings count too: the focus step and the app log their caught failures as warnings.
const collectErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test.describe("new tab page", () => {
  test("shows the time, date and greeting", async ({ newTab }) => {
    await newTab.clock.setFixedTime(new Date("2026-10-28T19:30:00+02:00"));
    await newTab.reload();
    await expect(newTab.locator(".clock__time")).toHaveText("19:30");
    await expect(newTab.locator(".clock__date")).toHaveText("Wednesday 28 October");
    await expect(newTab.locator(".clock__greeting")).toHaveText("Good evening");
  });

  test("lists top-level folders with their bookmark counts", async ({ newTab }) => {
    const sidebar = newTab.getByRole("navigation", { name: "Folders" });
    await expect(sidebar.getByRole("button")).toHaveText([
      "Home",
      "Work4 bookmarks",
      "Reading2 bookmarks",
      "Outdoors2 bookmarks",
      /^Bookmarks bar1 bookmark$/i,
    ]);
    await expect(sidebar.getByRole("button", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("starts on Home with an empty Favourites and the newest bookmarks", async ({ newTab }) => {
    const panel = newTab.getByRole("main");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Favourites");
    await expect(panel.locator(".panel__empty")).toContainText("Use the ☆");
    await expect(panel.getByRole("heading", { level: 3 })).toHaveText("Recently added");
    await expect(panel.locator(".link-card")).toHaveCount(8);
  });

  test.describe("when a new tab opens", () => {
    test.use({ focusStep: true });

    const openNewTab = async (newTab: Page, newTabUrl: string, address = newTabUrl) => {
      const page = await newTab.context().newPage();
      const visited: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) visited.push(frame.url());
      });
      const errors = collectErrors(page);
      await page.goto(address);
      return { page, visited, errors, focusUrl: `${newTabUrl}?focus` };
    };

    // This tab's settings listeners were added first, so they have run once this resolves.
    const nextSettingsChange = (page: Page) =>
      page.evaluateHandle(() => ({
        seen: new Promise<void>((resolve) => {
          chrome.storage.onChanged.addListener(() => {
            resolve();
          });
        }),
      }));

    test("steps forward to take focus and back to the new-tab entry", async ({
      newTab,
      newTabUrl,
    }) => {
      const tabsBefore = await newTab.evaluate(async () => (await chrome.tabs.query({})).length);
      const { page, visited, errors, focusUrl } = await openNewTab(newTab, newTabUrl);
      await expect(page.getByRole("combobox")).toBeFocused();
      await expect.poll(() => visited).toEqual([newTabUrl, focusUrl, newTabUrl]);
      // The tab never left the front, and no other tab was opened.
      const ownTab = await page.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
      const activeTabs = await page.evaluate(async () =>
        (await chrome.tabs.query({ active: true, currentWindow: true })).map((tab) => tab.id),
      );
      expect(activeTabs).toEqual([ownTab]);
      expect(await page.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(
        tabsBefore + 1,
      );
      await page.keyboard.type("git");
      await expect(page.getByRole("option").first()).toContainText("GitHub");
      expect(errors).toEqual([]);
    });

    test("takes focus the same way through the browser's new-tab address", async ({
      newTab,
      newTabUrl,
    }) => {
      const { page, visited, errors, focusUrl } = await openNewTab(
        newTab,
        newTabUrl,
        "chrome://newtab/",
      );
      await expect(page.getByRole("combobox")).toBeFocused();
      await expect.poll(() => visited).toEqual([newTabUrl, focusUrl, newTabUrl]);
      expect(errors).toEqual([]);
    });

    test("bounces straight back when Forward lands on the focus step", async ({
      newTab,
      newTabUrl,
    }) => {
      const { page, visited, errors, focusUrl } = await openNewTab(newTab, newTabUrl);
      await expect.poll(() => visited).toHaveLength(3);
      await page.goForward();
      await expect.poll(() => visited.slice(3)).toEqual([focusUrl, newTabUrl]);
      await expect(page.getByRole("button", { name: /^Work/ })).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("doesn't step again on a reload or on Back from a bookmark", async ({
      newTab,
      newTabUrl,
    }) => {
      const { page, visited, errors, focusUrl } = await openNewTab(newTab, newTabUrl);
      await expect.poll(() => visited).toEqual([newTabUrl, focusUrl, newTabUrl]);
      await expect(page.getByRole("button", { name: /^Work/ })).toBeVisible();

      await page.reload();
      await expect(page.getByRole("button", { name: /^Work/ })).toBeVisible();
      await page.getByRole("link", { name: /Trail map/ }).click();
      await expect(page).toHaveURL("https://trails.example.com/");
      await page.goBack();
      await expect(page.getByRole("button", { name: /^Work/ })).toBeVisible();
      expect(visited.slice(3)).toEqual([newTabUrl, "https://trails.example.com/", newTabUrl]);
      expect(errors).toEqual([]);
    });

    test("leaves focus alone once the setting is turned off in Settings", async ({
      newTab,
      newTabUrl,
    }) => {
      await newTab.getByRole("button", { name: "Settings" }).click();
      const settingsChange = await nextSettingsChange(newTab);
      await newTab.getByRole("checkbox", { name: /Put the cursor/ }).uncheck();
      await settingsChange.evaluate(({ seen }) => seen);

      const { page, visited, errors } = await openNewTab(newTab, newTabUrl);
      await expect(page.getByRole("button", { name: /^Work/ })).toBeVisible();
      expect(visited).toEqual([newTabUrl]);
      expect(errors).toEqual([]);
    });
  });

  test("opens a folder with its subfolders as sections", async ({ newTab }) => {
    await newTab.getByRole("button", { name: /^Work/ }).click();
    const panel = newTab.getByRole("main");

    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Work");
    await expect(panel.locator(".panel__note")).toHaveText("4 bookmarks");
    await expect(panel.getByRole("heading", { level: 3 })).toHaveText(["Dashboards"]);
    const grafana = panel.getByRole("link", { name: /IoT Grafana/ });
    await expect(grafana).toContainText("VPN");
    // A fresh profile has no favicon for the site, so the tile falls back to a letter.
    await expect(grafana.locator(".favicon-tile--monogram")).toHaveText("I");
    await expect(panel.getByRole("link", { name: /Jira board/ })).toContainText(
      "acme.atlassian.net",
    );
  });

  test("opens a bookmark in the current tab and remembers it as frequent", async ({
    newTab,
    newTabUrl,
  }) => {
    await newTab.getByRole("button", { name: /^Outdoors/ }).click();
    await newTab.getByRole("link", { name: /Trail map/ }).click();
    await expect(newTab).toHaveURL("https://trails.example.com/");

    await newTab.goto(newTabUrl);
    const panel = newTab.getByRole("main");
    await expect(panel.getByRole("heading", { level: 3 })).toHaveText("Frequent");
    await expect(panel.locator(".link-card").first()).toContainText("Trail map");
  });

  test("follows bookmark changes made in the browser", async ({ newTab }) => {
    await seedBookmarks(newTab, [
      { title: "Radio", children: [{ title: "Radio club", url: "https://radio.example.org/" }] },
    ]);
    await expect(newTab.getByRole("button", { name: "Radio 1" })).toBeVisible();
  });

  test("loads without console errors", async ({ context, newTabUrl }) => {
    const page = await context.newPage();
    const errors = collectErrors(page);
    await page.goto(newTabUrl);
    await expect(page.locator(".clock__time")).not.toBeEmpty();
    await expect(page.locator("#wallpaper")).toHaveAttribute("data-state", "ready");
    expect(errors).toEqual([]);
  });
});
