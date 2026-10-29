import { expect, test } from "./fixtures.ts";

test.describe("dynamic wallpaper", () => {
  test.describe("in another time zone", () => {
    test.use({ timezoneId: "America/Los_Angeles" });

    test("uses that zone's sun", async ({ context, newTabUrl }) => {
      const page = await context.newPage();
      // 13:00 in Tallinn is 03:00 in Los Angeles: night there.
      await page.clock.setFixedTime(new Date("2026-06-21T13:00:00+03:00"));
      await page.goto(newTabUrl);
      await expect(page.locator("#wallpaper")).toHaveAttribute("data-frame", "1");
    });
  });

  test("moves on to the next frame as time passes", async ({ context, newTabUrl }) => {
    const page = await context.newPage();
    const wallpaper = page.locator("#wallpaper");
    const visibleFrame = page.locator(".wallpaper__frame.is-visible");
    await page.clock.install({ time: new Date("2026-10-28T06:15:00+02:00") });
    await page.goto(newTabUrl);
    await expect(wallpaper).toHaveAttribute("data-frame", "2");
    await expect(visibleFrame).toHaveAttribute("src", "wallpapers/frame-2.png");

    await page.clock.runFor("01:00:00");
    await expect(wallpaper).toHaveAttribute("data-frame", "3");
    await expect(visibleFrame).toHaveAttribute("src", "wallpapers/frame-3.png");
  });

  test.describe("without a wallpaper", () => {
    test.use({ wallpaper: "none" });

    test("shows the default photo", async ({ context, newTabUrl }) => {
      const page = await context.newPage();
      await page.goto(newTabUrl);
      await expect(page.locator("#wallpaper")).toHaveAttribute(
        "data-background",
        "photo:autumn-forest",
      );
      await expect(page.locator(".wallpaper__frame.is-visible")).toHaveAttribute(
        "src",
        "backgrounds/autumn-forest.avif",
      );
      await expect(page.locator("#wallpaper")).not.toHaveAttribute("data-frame");
    });

    // Some AVIF encoders write files that Chromium decodes as fully transparent, which every
    // attribute check above would miss.
    test("every bundled photo decodes to visible pixels", async ({ context, newTabUrl }) => {
      const page = await context.newPage();
      await page.goto(newTabUrl);
      const names = ["alpine-ridge", "autumn-forest", "golden-haze", "still-lake"];
      const files = names.flatMap((name) => [
        `backgrounds/${name}.avif`,
        `backgrounds/thumbs/${name}.avif`,
      ]);
      const results = await page.evaluate(async (paths) => {
        const canvas = new OffscreenCanvas(32, 32);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No 2D context");
        return Promise.all(
          paths.map(async (path) => {
            const image = new Image();
            image.src = path;
            await image.decode();
            context.clearRect(0, 0, 32, 32);
            context.drawImage(image, 0, 0, 32, 32);
            const { data } = context.getImageData(0, 0, 32, 32);
            const pixels = Array.from({ length: data.length / 4 }, (_, i) => i * 4);
            return {
              path,
              opaque: pixels.every((i) => data[i + 3] === 255),
              varied: new Set(pixels.map((i) => data[i])).size > 8,
            };
          }),
        );
      }, files);
      expect(results).toEqual(files.map((path) => ({ path, opaque: true, varied: true })));
    });
  });
});
