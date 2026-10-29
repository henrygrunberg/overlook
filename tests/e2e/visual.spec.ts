import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, pin, seedBookmarks, test } from "./fixtures.ts";

// Screenshots for reviewing the design. They are written to test-results/ rather than compared
// pixel by pixel: the clock and your own wallpaper frames (kept local) differ per machine.
const hasRealWallpaper = existsSync(resolve(import.meta.dirname, "../../dist/wallpapers"));

const capture = async (page: Page, name: string) => {
  await expect(page.locator("#wallpaper")).toHaveAttribute("data-state", "ready");
  await page.evaluate(() =>
    Promise.allSettled(document.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
};

// Each capture waits out the background fade, so these take a while under a parallel run.
test.slow();

test.describe("visual review: default photo", { tag: "@visual" }, () => {
  test.use({ wallpaper: "none" });

  test("home, folder, search and settings", async ({ newTab }) => {
    await newTab.clock.setFixedTime(new Date("2026-10-28T17:30:00+02:00"));
    await newTab.reload();
    await capture(newTab, "default-home");

    await newTab.getByRole("button", { name: /^Work/ }).click();
    await capture(newTab, "default-folder");

    await newTab.getByRole("combobox").fill("dash");
    await capture(newTab, "default-spotlight");

    await newTab.keyboard.press("Escape");
    await newTab.keyboard.press("Escape");
    await newTab.getByRole("button", { name: "Settings" }).click();
    await capture(newTab, "default-settings");

    await newTab.getByRole("button", { name: "Edit label VPN" }).click();
    await newTab.getByLabel("Addresses tagged VPN").fill("jira.acme.com");
    await newTab.keyboard.press("Enter");
    await newTab
      .locator(".settings__section")
      .filter({ hasText: "Labels" })
      .scrollIntoViewIfNeeded();
    await capture(newTab, "default-labels");
  });

  test("favourites and a long folder list", async ({ newTab }) => {
    await seedBookmarks(
      newTab,
      Array.from({ length: 12 }, (_, index) => ({
        title: `Project ${index + 1}`,
        children: [{ title: "Docs", url: `https://p${index}.example.com/` }],
      })),
    );
    for (const [folder, title] of [
      [/^Outdoors/, "Trail map"],
      [/^Work/, "Jira board"],
      [/^Work/, "IoT Grafana"],
    ] as const) {
      await pin(newTab, folder, title);
    }
    await newTab.getByRole("button", { name: "Home", exact: true }).click();
    await newTab.locator(".panel__section .link-card").first().hover();
    await capture(newTab, "default-favourites");

    await newTab.getByRole("button", { name: "Edit" }).click();
    await capture(newTab, "default-favourites-editing");
  });

  test("narrow window", async ({ newTab }) => {
    await newTab.setViewportSize({ width: 760, height: 1000 });
    await newTab.getByRole("button", { name: /^Work/ }).click();
    await capture(newTab, "default-narrow");
  });
});

test.describe("visual review: your dynamic wallpaper", { tag: "@visual" }, () => {
  test.skip(!hasRealWallpaper, "Put a dynamic wallpaper in public/wallpapers and build first");
  test.use({ wallpaper: "real" });

  for (const [label, time] of [
    ["day", "2026-06-21T13:00:00+03:00"],
    ["dusk", "2026-10-28T17:30:00+02:00"],
    ["night", "2026-12-21T02:00:00+02:00"],
  ] as const) {
    test(`folder at ${label}`, async ({ newTab }) => {
      await newTab.clock.setFixedTime(new Date(time));
      await newTab.reload();
      await newTab.getByRole("button", { name: /^Work/ }).click();
      await capture(newTab, `wallpaper-${label}`);
    });
  }
});
