import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const STACKED_BELOW = 848;
const SCROLLS_BELOW_HEIGHT = 560;

const WIDTHS = [320, 480, 760, 847, 848, 960, 1040, 1100, 1180, 1280, 1440, 1920];
const SIZES = [
  ...WIDTHS.map((width) => ({ width, height: 900 })),
  { width: 1280, height: 600 },
  { width: 1280, height: 480 },
];

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
}

const intersects = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const centre = (box: Box) => box.left + box.width / 2;

function expectInside(
  box: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
) {
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

// The widest realistic clock: tabular digits, the longest weekday and month, "Good afternoon".
async function openWithWidestClock(page: Page) {
  await page.clock.setFixedTime(new Date("2026-09-30T17:58:00+03:00"));
  await page.reload();
  await expect(page.locator(".clock__date")).toHaveText("Wednesday 30 September");
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string, measuring: "element" | "text" = "element"): Box => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const range = document.createRange();
      range.selectNodeContents(element);
      const target = measuring === "text" ? range : element;
      const { left, right, top, bottom, width } = target.getBoundingClientRect();
      return { left, right, top, bottom, width };
    };
    return {
      // The clock's lines are block boxes as wide as the widest of them, so measure their text.
      time: box(".clock__time", "text"),
      date: box(".clock__date", "text"),
      greeting: box(".clock__greeting", "text"),
      search: box(".spotlight__field"),
      sidebar: box(".sidebar"),
      panel: box(".panel"),
      settingsButton: box(".settings-button"),
      viewport: { width: innerWidth, height: innerHeight },
      scroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    };
  });
}

async function expectSoundLayout(page: Page) {
  const layout = await measure(page);
  const { time, date, greeting, search, sidebar, panel, settingsButton, viewport, scroll } = layout;
  const clockLines = [time, date, greeting];

  expect(scroll.width).toBeLessThanOrEqual(viewport.width);
  for (const line of clockLines) {
    expect(intersects(line, search)).toBe(false);
    expect(intersects(line, sidebar)).toBe(false);
    expect(intersects(line, panel)).toBe(false);
    expect(intersects(line, settingsButton)).toBe(false);
  }
  expect(intersects(search, settingsButton)).toBe(false);
  expect(intersects(sidebar, panel)).toBe(false);

  if (viewport.width < STACKED_BELOW) {
    expect(Math.max(...clockLines.map((line) => line.bottom))).toBeLessThanOrEqual(search.top);
    expect(search.bottom).toBeLessThanOrEqual(panel.top);
    expect(panel.bottom).toBeLessThanOrEqual(sidebar.top);
  } else {
    expect(sidebar.width).toBeGreaterThanOrEqual(Math.max(...clockLines.map((line) => line.width)));
    expect(Math.abs(panel.left - search.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(centre(time) - centre(sidebar))).toBeLessThanOrEqual(2);
    if (viewport.height > SCROLLS_BELOW_HEIGHT) {
      expect(scroll.height).toBeLessThanOrEqual(viewport.height);
      expect(Math.max(sidebar.bottom, panel.bottom)).toBeLessThanOrEqual(viewport.height);
    }
  }
  return layout;
}

test("nothing overlaps at any window size", async ({ newTab }) => {
  for (const size of SIZES) {
    await test.step(`${size.width}×${size.height}`, async () => {
      await newTab.setViewportSize(size);
      await openWithWidestClock(newTab);
      await expectSoundLayout(newTab);
    });
  }
});

test("the settings button scrolls away with a scrolling page", async ({ newTab }) => {
  for (const size of [
    { width: 760, height: 900 },
    { width: 1280, height: 480 },
  ]) {
    await newTab.setViewportSize(size);
    for (const scrollTop of [0, 220, Number.MAX_SAFE_INTEGER]) {
      await newTab.evaluate((top) => {
        scrollTo(0, top);
      }, scrollTop);
      const { search, sidebar, panel, settingsButton } = await measure(newTab);
      for (const region of [search, sidebar, panel]) {
        expect(intersects(region, settingsButton)).toBe(false);
      }
    }
  }
});

test("the layout follows the window as it is resized", async ({ newTab }) => {
  await openWithWidestClock(newTab);
  const before = await expectSoundLayout(newTab);
  for (const width of [1000, 800, 1440]) {
    await newTab.setViewportSize({ width, height: 900 });
    await expectSoundLayout(newTab);
  }
  expect(await measure(newTab)).toEqual(before);
});

async function addBookmarksMatching(page: Page, query: string, count: number) {
  await page.evaluate(
    async ({ query, count }) => {
      for (let n = 1; n <= count; n += 1) {
        await chrome.bookmarks.create({
          parentId: "1",
          title: `${query} ${n}`,
          url: `https://reports.example.com/${n}`,
        });
      }
    },
    { query, count },
  );
}

test("search results and settings stay inside the window", async ({ newTab }) => {
  await addBookmarksMatching(newTab, "Acme report", 12);
  const listbox = newTab.locator(".spotlight__listbox");
  for (const size of [
    { width: 320, height: 900 },
    { width: 760, height: 900 },
    { width: 760, height: 700 },
    { width: 600, height: 600 },
    { width: 900, height: 900 },
    { width: 1440, height: 900 },
  ]) {
    await newTab.setViewportSize(size);
    await newTab.getByRole("combobox").fill("Acme report");
    const popover = newTab.locator(".spotlight__popover");
    await expect(popover).toBeVisible();
    await expect
      .poll(() => listbox.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    expectInside(await popover.boundingBox(), size);
    await newTab.getByRole("combobox").fill("");
    await newTab.keyboard.press("Escape");
  }

  for (const size of [
    { width: 320, height: 600 },
    { width: 1280, height: 480 },
  ]) {
    await newTab.setViewportSize(size);
    await newTab.getByRole("button", { name: "Settings" }).click();
    const dialog = newTab.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expectInside(await dialog.boundingBox(), size);
    const overflowsSideways = await dialog.evaluate((element) =>
      [element, element.querySelector(".settings__body")].some(
        (scroller) => !scroller || scroller.scrollWidth > scroller.clientWidth,
      ),
    );
    expect(overflowsSideways).toBe(false);
    await newTab.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("Tab reaches the content in the order it is shown", async ({ newTab }) => {
  const firstRegionAfterSearch = async () => {
    await newTab.getByRole("combobox").focus();
    for (let step = 0; step < 5; step++) {
      await newTab.keyboard.press("Tab");
      const region = await newTab.evaluate(
        () => document.activeElement?.closest(".sidebar, .panel")?.id ?? null,
      );
      if (region) return region;
    }
    return null;
  };

  expect(await firstRegionAfterSearch()).toBe("sidebar");
  await newTab.setViewportSize({ width: 760, height: 900 });
  expect(await firstRegionAfterSearch()).toBe("panel");
});

test.describe("visual review: window widths", { tag: "@visual" }, () => {
  test.use({ wallpaper: "none" });

  test("home at each width", async ({ newTab }) => {
    test.slow();
    await openWithWidestClock(newTab);
    await expect(newTab.locator("#wallpaper")).toHaveAttribute("data-state", "ready");
    for (const width of [1440, 1100, 960, 760, 480]) {
      await newTab.setViewportSize({ width, height: 900 });
      await newTab.evaluate(async () => {
        await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
        // Without a fresh frame the capture can still hold tiles painted at the previous size.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await newTab.screenshot({ path: test.info().outputPath(`width-${width}.png`) });
      // A full-page capture paints the fixed wallpaper only once, so scroll to the folders instead.
      if (width < STACKED_BELOW) {
        await newTab.locator(".sidebar").scrollIntoViewIfNeeded();
        await newTab.screenshot({ path: test.info().outputPath(`width-${width}-folders.png`) });
        await newTab.evaluate(() => {
          scrollTo(0, 0);
        });
      }
    }
  });
});
