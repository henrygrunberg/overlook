import { inflateSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import { expect, pin, test } from "./fixtures.ts";

// WCAG 2.2: 4.5:1 for text, 3:1 for large text (24px, or 18.66px bold) and for indicators.
const TEXT = 4.5;
const LARGE = 3;

const TEXT_TARGETS = [
  [".clock__time", LARGE],
  [".clock__greeting", LARGE],
  [".clock__date", TEXT],
  [".spotlight__input", TEXT],
  [".sidebar__label", TEXT],
  [".sidebar__count", TEXT],
  [".panel__title", LARGE],
  [".panel__note", TEXT],
  [".panel__action", TEXT],
  [".panel__section-title", TEXT],
  [".panel .link-card__title", TEXT],
  [".panel .link-card__detail", TEXT],
  [".panel .chip", TEXT],
] as const;

type TextTarget = (typeof TEXT_TARGETS)[number] | readonly [string, number];

const CLOCK_TARGETS = TEXT_TARGETS.filter(([selector]) => selector.startsWith(".clock"));

const RESULT_TARGETS = [
  [".spotlight__group-label", TEXT],
  ['.spotlight__option:not([aria-selected="true"]) .spotlight__option-title', TEXT],
  ['.spotlight__option:not([aria-selected="true"]) .spotlight__option-detail', TEXT],
  [".spotlight__footer", TEXT],
] as const;

/** An image drawn in the page: a size and the rectangles painted on it, in order. */
interface Drawing {
  readonly width: number;
  readonly height: number;
  readonly fills: readonly (readonly [color: string, x: number, y: number, w: number, h: number])[];
}

const plain = (color: string): Drawing => ({
  width: 64,
  height: 64,
  fills: [[color, 0, 0, 64, 64]],
});

const BACKGROUNDS: readonly ({ name: string } & ({ photo: string } | { upload: Drawing }))[] = [
  { name: "Autumn forest", photo: "autumn-forest" },
  { name: "Still lake", photo: "still-lake" },
  { name: "Golden haze", photo: "golden-haze" },
  { name: "Alpine ridge", photo: "alpine-ridge" },
  { name: "a white upload", upload: plain("#fff") },
  { name: "a pale upload", upload: plain("rgb(222 236 250)") },
  { name: "a mid-grey upload", upload: plain("rgb(118 118 118)") },
  { name: "a sky-blue upload", upload: plain("rgb(110 165 225)") },
  {
    name: "a dark upload with a bright corner behind the clock",
    upload: {
      width: 1600,
      height: 1000,
      fills: [
        ["rgb(20 24 30)", 0, 0, 1600, 1000],
        ["#fff", 0, 0, 450, 280],
      ],
    },
  },
];

/** A PNG of the drawing, made by the page's own canvas. */
async function png(page: Page, { width, height, fills }: Drawing): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ width, height, fills }) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D canvas");
      for (const [color, x, y, w, h] of fills) {
        context.fillStyle = color;
        context.fillRect(x, y, w, h);
      }
      const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
    },
    { width, height, fills },
  );
  return Buffer.from(base64, "base64");
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Result {
  readonly label: string;
  readonly ratio: number;
  readonly minimum: number;
}

type Rgb = readonly [number, number, number];

interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly rgb: (x: number, y: number) => Rgb;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Decodes Chromium's 8-bit RGB or RGBA screenshots. */
function decodePng(png: Buffer): Pixels {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (data[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = x >= channels && y > 0 ? (data[(y - 1) * stride + x - channels] ?? 0) : 0;
      const predicted =
        [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upLeft)][filter ?? 0] ?? 0;
      data[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    rgb: (x, y) => {
      const index = Math.round(y) * stride + Math.round(x) * channels;
      return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
    },
  };
}

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = ([red, green, blue]: Rgb) =>
  0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
const difference = (a: Rgb, b: Rgb) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const blend = (top: Rgb, alpha: number, bottom: Rgb): Rgb => [
  alpha * top[0] + (1 - alpha) * bottom[0],
  alpha * top[1] + (1 - alpha) * bottom[1],
  alpha * top[2] + (1 - alpha) * bottom[2],
];
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The 10th percentile: a tenth of the pixels may fall short, as on a shadow's soft edge. */
function low(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.floor(sorted.length / 10)] ?? 0) * 100) / 100;
}

async function adoptStyle(page: Page, css: string) {
  await page.evaluate(async (text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    document.adoptedStyleSheets = [sheet];
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, css);
}

const screenshot = async (page: Page) =>
  decodePng(await page.screenshot({ animations: "disabled" }));

function textTargets(page: Page, targets: readonly TextTarget[]) {
  return page.evaluate((targets) => {
    const opacityOf = (element: Element | null): number =>
      element ? Number(getComputedStyle(element).opacity) * opacityOf(element.parentElement) : 1;
    return targets.flatMap(([selector, minimum]) =>
      [...document.querySelectorAll(selector)].slice(0, 8).flatMap((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        if (width === 0 || y + height > innerHeight) return [];
        const isField = element instanceof HTMLInputElement;
        const style = getComputedStyle(element, isField ? "::placeholder" : null);
        const [red = 0, green = 0, blue = 0, alpha = 1] = (style.color.match(/[\d.]+/g) ?? []).map(
          Number,
        );
        const text = isField ? element.placeholder : element.textContent;
        return [
          {
            label: `${selector} "${text.trim().slice(0, 24)}"`,
            box: { x, y, width, height },
            color: [red, green, blue] as const,
            alpha: alpha * Number(style.opacity) * opacityOf(element.parentElement),
            minimum,
          },
        ];
      }),
    );
  }, targets);
}

/**
 * Each text's colour against the backdrop behind its glyphs, shadow included. Glyph pixels are
 * the ones mostly covered by the text: where white text differs from black text.
 */
async function textContrast(
  page: Page,
  targets: readonly TextTarget[] = TEXT_TARGETS,
): Promise<Result[]> {
  const shown = await textTargets(page, targets);
  const all = "*, *::placeholder";
  const plain = (color: string) =>
    `${all} { color: ${color} !important; text-shadow: none !important; }`;
  await adoptStyle(page, plain("#fff"));
  const white = await screenshot(page);
  await adoptStyle(page, plain("#000"));
  const black = await screenshot(page);
  await adoptStyle(page, `${all} { color: transparent !important; }`);
  const backdrop = await screenshot(page);
  await adoptStyle(page, "");

  return shown.map(({ label, box, color, alpha, minimum }) => {
    const ratios: number[] = [];
    for (let y = Math.ceil(box.y); y < box.y + box.height; y++) {
      for (let x = Math.ceil(box.x); x < box.x + box.width; x++) {
        if (difference(white.rgb(x, y), black.rgb(x, y)) < 0.5 * 3 * 255) continue;
        const behind = backdrop.rgb(x, y);
        ratios.push(ratio(luminance(blend(color, alpha, behind)), luminance(behind)));
      }
    }
    return { label, ratio: low(ratios), minimum };
  });
}

/** A focus ring is drawn 2px outside the element and 2px wide: sample its straight edges. */
function ringPoints(box: Box, radius: number): [number, number][] {
  const straight = Math.min(radius + 2, box.width / 2 - 2, box.height / 2 - 2);
  const points: [number, number][] = [];
  for (let x = Math.ceil(box.x + straight); x < box.x + box.width - straight; x++) {
    points.push([x, Math.floor(box.y) - 3], [x, Math.ceil(box.y + box.height) + 2]);
  }
  for (let y = Math.ceil(box.y + straight); y < box.y + box.height - straight; y++) {
    points.push([Math.floor(box.x) - 3, y], [Math.ceil(box.x + box.width) + 2, y]);
  }
  return points;
}

async function ringContrast(
  page: Page,
  element: Locator,
  label: string,
  ring: Locator = element,
): Promise<Result> {
  await element.blur();
  const before = await screenshot(page);
  await element.evaluate((target) => {
    if (target instanceof HTMLElement) target.focus({ focusVisible: true });
  });
  const after = await screenshot(page);
  await element.blur();
  const box = await ring.boundingBox();
  if (!box) throw new Error(`${label} isn't shown`);
  const radius = await ring.evaluate((target) =>
    parseFloat(getComputedStyle(target).borderTopLeftRadius),
  );
  const ratios = ringPoints(box, radius)
    .filter(([x, y]) => x >= 0 && y >= 0 && x < before.width && y < before.height)
    .map(([x, y]) => ratio(luminance(before.rgb(x, y)), luminance(after.rgb(x, y))));
  return { label: `${label} focus ring`, ratio: low(ratios), minimum: LARGE };
}

async function showBackground(page: Page, background: (typeof BACKGROUNDS)[number]) {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  if ("photo" in background) {
    await dialog.getByRole("button", { name: new RegExp(background.name) }).click();
    await expect(page.locator("#wallpaper")).toHaveAttribute(
      "data-background",
      `photo:${background.photo}`,
    );
  } else {
    await dialog.getByLabel("Choose a background image").setInputFiles({
      name: "background.png",
      mimeType: "image/png",
      buffer: await png(page, background.upload),
    });
    await expect(page.locator("#wallpaper")).toHaveAttribute("data-background", "custom");
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test.describe("contrast on every background", () => {
  test.use({ wallpaper: "none" });
  test.slow();

  for (const background of BACKGROUNDS) {
    test(`text and focus rings stay legible on ${background.name}`, async ({ newTab }) => {
      await newTab.emulateMedia({ reducedMotion: "reduce" });
      await newTab.clock.setFixedTime(new Date("2026-09-30T17:58:00+03:00"));
      await newTab.reload();
      await pin(newTab, /^Work/, "Confluence");
      await pin(newTab, /^Work/, "Load testing Grafana");
      await showBackground(newTab, background);

      const results: Result[] = [];
      for (const folder of ["Home", "Work"]) {
        await newTab.getByRole("button", { name: new RegExp(`^${folder}`) }).click();
        await newTab.mouse.move(0, 0);
        await newTab.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        results.push(...(await textContrast(newTab)));
        const cards = newTab.locator(".panel .link-card");
        for (let index = 0; index < Math.min(4, await cards.count()); index++) {
          results.push(await ringContrast(newTab, cards.nth(index), `${folder} card ${index + 1}`));
        }
      }
      results.push(
        await ringContrast(newTab, newTab.getByRole("button", { name: "Settings" }), "Settings"),
      );
      await newTab.getByRole("combobox").fill("a");
      await expect(newTab.locator(".spotlight__popover")).toBeVisible();
      results.push(...(await textContrast(newTab, RESULT_TARGETS)));
      await newTab.getByRole("combobox").fill("");
      // A short window leaves the clock the least of the scrim's own gradient.
      await newTab.setViewportSize({ width: 1024, height: 560 });
      await newTab.mouse.move(0, 0);
      await newTab.evaluate(
        () => new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted))),
      );
      const short = await textContrast(newTab, CLOCK_TARGETS);
      results.push(...short.map((result) => ({ ...result, label: `1024x560 ${result.label}` })));
      const failing = results.filter(({ ratio, minimum }) => ratio < minimum);
      expect(failing, JSON.stringify(results, null, 1)).toEqual([]);
    });
  }
});

test.describe("the tint over a thin bright strip behind the clock's date", () => {
  test.use({ wallpaper: "none" });

  for (const { window, image } of [
    { window: { width: 1440, height: 900 }, image: { width: 1600, height: 1000 } },
    { window: { width: 1440, height: 900 }, image: { width: 2700, height: 900 } },
    { window: { width: 2560, height: 1600 }, image: { width: 900, height: 1600 } },
  ]) {
    test(`keeps the date legible on a ${image.width}x${image.height} upload in a ${window.width}x${window.height} window`, async ({
      newTab,
    }) => {
      await newTab.setViewportSize(window);
      await newTab.emulateMedia({ reducedMotion: "reduce" });
      const date = await newTab.locator(".clock__date").boundingBox();
      if (!date) throw new Error("No date");
      // Where object-fit: cover and object-position 50% 45% put a 28px band around the date.
      const scale = Math.max(window.width / image.width, window.height / image.height);
      const top = (window.height - image.height * scale) * 0.45;
      const stripTop = (date.y + date.height / 2 - 14 - top) / scale;
      await showBackground(newTab, {
        name: "a dark upload with a bright strip behind the date",
        upload: {
          ...image,
          fills: [
            ["rgb(20 24 30)", 0, 0, image.width, image.height],
            ["#fff", 0, Math.round(stripTop), image.width, Math.round(28 / scale)],
          ],
        },
      });
      await newTab.mouse.move(0, 0);
      const results = await textContrast(newTab, [[".clock__date", TEXT]]);
      expect(results).toHaveLength(1);
      const failing = results.filter(({ ratio, minimum }) => ratio < minimum);
      expect(failing, JSON.stringify(results)).toEqual([]);
    });
  }
});

async function openLabelEditor(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Edit label VPN" }).click();
  await dialog.getByLabel("Addresses tagged VPN").fill("jira.acme.com");
  await page.keyboard.press("Enter");
  return dialog;
}

test("label colour swatches stand out from the dialog", async ({ newTab }) => {
  await openLabelEditor(newTab);
  const swatches = newTab.locator(".label-editor__colour");
  await swatches.first().scrollIntoViewIfNeeded();
  await newTab.mouse.move(0, 0);
  const shot = await screenshot(newTab);
  const results: Result[] = [];
  for (const box of await Promise.all(
    (await swatches.all()).map((swatch) => swatch.boundingBox()),
  )) {
    if (!box) throw new Error("A swatch isn't shown");
    const middle = box.y + box.height / 2;
    results.push({
      label: `swatch at ${Math.round(box.x)}`,
      ratio: low([
        ratio(
          luminance(shot.rgb(box.x + box.width / 2, middle)),
          luminance(shot.rgb(box.x - 4, middle)),
        ),
      ]),
      minimum: LARGE,
    });
  }
  expect(results).toHaveLength(6);
  expect(results.filter((result) => result.ratio < result.minimum)).toEqual([]);
});

test("label chips are opaque, so they read the same on any backdrop", async ({ newTab }) => {
  // The "+N" chip has no colour of its own, so it is the one most likely to lose its fill.
  const backgrounds = await newTab.evaluate(() =>
    ["green", "blue", "orange", "purple", "red", "gray"]
      .map((color) => `chip--${color}`)
      .concat("label-chip--more")
      .map((variant) => {
        const chip = document.createElement("span");
        chip.className = `chip ${variant}`;
        document.body.append(chip);
        const { backgroundColor } = getComputedStyle(chip);
        chip.remove();
        return [variant, backgroundColor];
      }),
  );
  expect(backgrounds).toHaveLength(7);
  expect(backgrounds.filter(([, color]) => /transparent|rgba|\//.test(color ?? ""))).toEqual([]);
});

interface FadeTrace {
  /** How much of the dark base showed through both layers at worst. */
  readonly darkest: number;
  /** The opacity of the layer showing the photo, frame by frame from when it got the photo. */
  readonly incoming: readonly number[];
}

/** Follows the wallpaper's two layers for 6 s while the photo comes in. */
function traceFade(page: Page, photo: string): Promise<FadeTrace> {
  return page.evaluate(
    (photo) =>
      new Promise<FadeTrace>((resolve) => {
        const frames = [...document.querySelectorAll<HTMLImageElement>(".wallpaper__frame")];
        let darkest = 0;
        const incoming: number[] = [];
        const started = performance.now();
        const sample = () => {
          const opacities = frames.map((frame) => Number(getComputedStyle(frame).opacity));
          darkest = Math.max(
            darkest,
            opacities.reduce((shown, opacity) => shown * (1 - opacity), 1),
          );
          const layer = frames.findIndex((frame) => frame.src.endsWith(`/${photo}.avif`));
          if (layer >= 0) incoming.push(opacities[layer] ?? 0);
          if (performance.now() - started < 6000) requestAnimationFrame(sample);
          else resolve({ darkest, incoming });
        };
        requestAnimationFrame(sample);
      }),
    photo,
  );
}

test.describe("switching the background", () => {
  test.beforeEach(async ({ newTab }) => {
    await expect(newTab.locator("#wallpaper")).toHaveAttribute("data-state", "ready");
    await newTab.evaluate(() =>
      Promise.allSettled(document.getAnimations().map((animation) => animation.finished)),
    );
    await newTab.getByRole("button", { name: "Settings" }).click();
  });

  test("cross-fades, and the dark base never shows through", async ({ newTab }) => {
    const fade = traceFade(newTab, "still-lake");
    await newTab.getByRole("button", { name: /Still lake/ }).click();
    const { darkest, incoming } = await fade;
    expect(darkest).toBeLessThan(0.02);
    expect(incoming[0]).toBeLessThan(0.2);
    expect(Math.max(...incoming)).toBe(1);
  });

  test("still cross-fades when the next background is picked during the last fade", async ({
    newTab,
  }) => {
    await newTab.getByRole("button", { name: /Still lake/ }).click();
    await newTab.waitForTimeout(800);
    const fade = traceFade(newTab, "golden-haze");
    await newTab.getByRole("button", { name: /Golden haze/ }).click();
    const { darkest, incoming } = await fade;
    expect(darkest).toBeLessThan(0.02);
    expect(incoming[0]).toBeLessThan(0.2);
    expect(Math.max(...incoming)).toBe(1);
  });
});

test.describe("the tint", () => {
  test.use({ wallpaper: "none" });

  test("darkens only what is behind the text: a bright photo keeps its brightness below the panels", async ({
    newTab,
  }) => {
    await newTab.emulateMedia({ reducedMotion: "reduce" });
    await showBackground(newTab, { name: "Alpine ridge", photo: "alpine-ridge" });
    // Below the panels and above the scrim's bottom vignette, which starts at 72%.
    const brightness = async () => {
      const shot = await screenshot(newTab);
      const values: number[] = [];
      for (let y = Math.ceil(shot.height * 0.64); y < shot.height * 0.72; y += 2) {
        for (let x = 0; x < shot.width; x += 2) values.push(luminance(shot.rgb(x, y)));
      }
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    const hidePage = ".page { visibility: hidden !important; }";
    await adoptStyle(newTab, hidePage);
    const shown = await brightness();
    await adoptStyle(newTab, `${hidePage} .wallpaper__scrim { display: none !important; }`);
    const bare = await brightness();
    expect(shown / bare).toBeGreaterThan(0.95);
  });
});

test("a card keeps its hover look while the pointer is on its star", async ({ newTab }) => {
  await newTab.emulateMedia({ reducedMotion: "reduce" });
  await newTab.getByRole("button", { name: /^Work/ }).click();
  const card = newTab.locator(".panel .link-card").first();
  const look = () => card.evaluate((element) => getComputedStyle(element).transform);
  const resting = await look();
  await newTab.locator(".panel .card-action--toggle-pin").first().hover();
  await expect.poll(look).not.toBe(resting);
});

test.describe("forced colors", () => {
  test.beforeEach(async ({ newTab }) => {
    await newTab.emulateMedia({ forcedColors: "active", colorScheme: "light" });
  });

  test("the current folder has its own marker, so a ring always means focus", async ({
    newTab,
  }) => {
    const current = newTab.locator('.sidebar__item[aria-current="page"]');
    const borders = await current.evaluate((element) => {
      const style = getComputedStyle(element);
      return { top: style.borderTopWidth, start: style.borderLeftWidth };
    });
    expect(borders).toEqual({ top: "0px", start: "4px" });
  });

  test("borderless buttons get an outline", async ({ newTab }) => {
    await pin(newTab, /^Work/, "Confluence");
    await newTab.getByRole("button", { name: "Home", exact: true }).click();
    await newTab.getByRole("button", { name: "Edit" }).click();
    await openLabelEditor(newTab);
    const widths = await newTab.evaluate(() =>
      [
        ".sidebar__more",
        ".panel__action",
        ".card-action",
        ".spotlight__scope",
        ".settings__close",
        ".label-row__toggle",
        ".host-chip__remove",
        ".label-row__delete",
        ".label-editor__colour:not(:checked)",
      ].map((selector) => {
        const element = document.querySelector(selector);
        return [selector, element ? getComputedStyle(element).borderTopWidth : "missing"];
      }),
    );
    expect(widths.filter(([, width]) => width !== "1px")).toEqual([]);
  });

  test("a pinned star follows the theme instead of staying yellow", async ({ newTab }) => {
    await pin(newTab, /^Work/, "Confluence");
    await newTab.getByRole("button", { name: "Home", exact: true }).click();
    const fills = await newTab.evaluate(() =>
      [...document.querySelectorAll(".icon--filled-star, .is-pinned .card-action .icon")].map(
        (icon) => getComputedStyle(icon).fill,
      ),
    );
    expect(fills.length).toBeGreaterThanOrEqual(2);
    expect(fills).not.toContain("rgb(255, 214, 10)");
  });

  test("the selected search result is outlined", async ({ newTab }) => {
    await newTab.getByRole("combobox").fill("jira");
    const selected = newTab.locator('.spotlight__option[aria-selected="true"]');
    await expect(selected).toBeVisible();
    expect(await selected.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      "solid",
    );
  });

  test("the empty search field shows that it has focus", async ({ newTab }) => {
    await newTab.keyboard.press("/");
    await expect(newTab.getByRole("combobox")).toBeFocused();
    expect(
      await newTab
        .locator(".spotlight__field")
        .evaluate((field) => getComputedStyle(field).outlineStyle),
    ).toBe("solid");
  });
});

test("the skip link appears when it gets focus", async ({ newTab }) => {
  const skipLink = newTab.getByRole("link", { name: /^Skip to/ });
  expect((await skipLink.boundingBox())?.width).toBeLessThanOrEqual(1);
  await skipLink.focus();
  const box = await skipLink.boundingBox();
  expect(box?.width).toBeGreaterThan(40);
  expect(box?.height).toBeGreaterThan(20);
});
