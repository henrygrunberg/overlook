import type { BackgroundChoice } from "../settings/settings";
import { warn, warnOnFailure } from "../log";
import { h } from "./dom";
import { currentFrame, loadDynamicWallpaper } from "../wallpaper/dynamic-wallpaper";
import { readCustomBackground } from "../backgrounds/custom-background";
import { DEFAULT_PHOTO, photoSrc } from "../backgrounds/photos";

const DYNAMIC_UPDATE_MS = 60_000;
// At least 128x80 whatever the image's shape, so a cell stays near 20 CSS px up to a 2560x1600
// window: fine enough for a bright detail behind the clock's date.
const SAMPLE_WIDTH = 128;
const SAMPLE_HEIGHT = 80;
// The wallpaper's object-position in styles.css.
const FOCUS_X = 0.5;
const FOCUS_Y = 0.45;
// A focus ring is 2px wide, 2px outside its element.
const RING_REACH = 4;
// For an image that couldn't be measured, which still shows: enough for all but the brightest.
const FALLBACK_TINT = 0.5;

/** "top" is the band behind the clock, the search field and Settings; "results" the search popover. */
type Surface = "top" | "results" | "sidebar" | "panel";

// The brightest luminance each surface takes untinted, read at the 95th percentile of the image it
// covers: its dimmest text keeps 4.7:1 there (4.5 plus room for other platforms' font rendering),
// as measured on uniform uploads with the contrast harness of appearance.spec.ts.
const UNTINTED_LIMIT: Readonly<Record<Surface, number>> = {
  top: 0.183,
  results: 0.393,
  sidebar: 0.075,
  panel: 0.096,
};

interface Area {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface LuminanceGrid {
  readonly width: number;
  readonly height: number;
  readonly cells: Float32Array;
}

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const encoded = (luminance: number) =>
  luminance <= 0.0031308 ? 12.92 * luminance : 1.055 * luminance ** (1 / 2.4) - 0.055;

/** How much a surface darkens what's behind it, given the luminance of the image cells it covers. */
export function tintOver(luminances: readonly number[], limit: number): number {
  const sorted = [...luminances].sort((a, b) => a - b);
  const bright = encoded(sorted[Math.floor(sorted.length * 0.95)] ?? 0);
  const allowed = encoded(limit);
  return bright <= allowed ? 0 : Math.ceil((1 - allowed / bright) * 100) / 100;
}

// From the file, not the <img>: decoding a Blob runs off the main thread, drawing the <img> into a
// canvas would decode the full image again on it (about 40 ms for a bundled photo).
async function measure(image: Blob | string): Promise<LuminanceGrid> {
  const file = image instanceof Blob ? image : await (await fetch(image)).blob();
  let bitmap = await createImageBitmap(file, { resizeWidth: SAMPLE_WIDTH, resizeQuality: "high" });
  if (bitmap.height < SAMPLE_HEIGHT) {
    bitmap.close();
    bitmap = await createImageBitmap(file, { resizeHeight: SAMPLE_HEIGHT, resizeQuality: "high" });
  }
  const { width, height } = bitmap;
  const context = new OffscreenCanvas(width, height).getContext("2d");
  if (!context) throw new Error("No 2D canvas to measure the image on");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, width, height).data;
  const cells = Float32Array.from({ length: width * height }, (_, cell) => {
    const [red = 0, green = 0, blue = 0] = pixels.subarray(cell * 4, cell * 4 + 3);
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  });
  return { width, height, cells };
}

/** The cells of the image that object-fit: cover puts behind an area of the window. */
function cellsBehind(grid: LuminanceGrid, area: Area): number[] {
  const scale = Math.max(innerWidth / grid.width, innerHeight / grid.height);
  const left = (innerWidth - grid.width * scale) * FOCUS_X;
  const top = (innerHeight - grid.height * scale) * FOCUS_Y;
  const span = (start: number, end: number, origin: number, size: number) => {
    const first = Math.min(size - 1, Math.max(0, Math.floor((start - origin) / scale)));
    const last = Math.min(size - 1, Math.max(first, Math.ceil((end - origin) / scale) - 1));
    return [first, last] as const;
  };
  const [firstColumn, lastColumn] = span(area.left, area.right, left, grid.width);
  const [firstRow, lastRow] = span(area.top, area.bottom, top, grid.height);
  const cells: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      cells.push(grid.cells[row * grid.width + column] ?? 0);
    }
  }
  return cells;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element;
}

const grown = (box: Area, margin: number): Area => ({
  left: box.left - margin,
  right: box.right + margin,
  top: box.top - margin,
  bottom: box.bottom + margin,
});

const union = (a: Area, b: Area): Area => ({
  left: Math.min(a.left, b.left),
  right: Math.max(a.right, b.right),
  top: Math.min(a.top, b.top),
  bottom: Math.max(a.bottom, b.bottom),
});

/** The clock with its date and greeting, which hang below it in the wide layout. */
function clockArea(): Area {
  const clock = byId("clock");
  return [...clock.querySelectorAll("*")]
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.width > 0)
    .reduce<Area>(union, clock.getBoundingClientRect());
}

/** The parts of the window each surface's text and focus rings can be over, scrolling included. */
function surfaceAreas(): Record<Surface, Area[]> {
  const page = document.documentElement;
  const scrollRange = page.scrollHeight - page.clientHeight;
  // From where it is with the page scrolled to the end to where it is unscrolled.
  const reach = ({ left, right, top, bottom }: Area, lowest = bottom + scrollY): Area => ({
    left,
    right,
    top: Math.max(0, top + scrollY - scrollRange),
    bottom: lowest,
  });
  const search = byId("spotlight-slot").getBoundingClientRect();
  const settings = [...document.querySelectorAll(".settings-button")].map((button) =>
    reach(grown(button.getBoundingClientRect(), RING_REACH)),
  );
  return {
    top: [reach(clockArea()), reach(grown(search, RING_REACH)), ...settings],
    results: [
      reach(
        { left: search.left, right: search.right, top: search.bottom, bottom: innerHeight },
        innerHeight,
      ),
    ],
    sidebar: [reach(byId("sidebar").getBoundingClientRect(), innerHeight)],
    panel: [reach(byId("panel").getBoundingClientRect(), innerHeight)],
  };
}

function surfaceTints(luminance: LuminanceGrid): Record<Surface, number> {
  const areas = surfaceAreas();
  const tint = (surface: Surface) =>
    Math.max(
      ...areas[surface].map((area) =>
        tintOver(cellsBehind(luminance, area), UNTINTED_LIMIT[surface]),
      ),
    );
  return {
    top: tint("top"),
    results: tint("results"),
    sidebar: tint("sidebar"),
    panel: tint("panel"),
  };
}

export class BackgroundView {
  private readonly layers: readonly [HTMLImageElement, HTMLImageElement];
  private visibleLayer: 0 | 1 = 0;
  private requestedSrc: string | null = null;
  /** The result for requestedSrc: a second request while it decodes must share its outcome. */
  private requested: Promise<boolean> = Promise.resolve(true);
  private shownSrc: string | null = null;
  /** A frame that failed to decode isn't tried again every minute. */
  private readonly undecodable = new Set<string>();
  private objectUrl: string | null = null;
  /** The shown image's luminance, kept to re-tint the glass when the layout changes. */
  private shownLuminance: LuminanceGrid | null = null;
  private dynamicTimer: number | undefined;
  private choice: BackgroundChoice = { kind: "auto" };
  /** Bumped on every apply(), so a slower earlier call can't start a stale timer or image. */
  private generation = 0;

  constructor(private readonly root: HTMLElement) {
    this.layers = [
      h("img", { className: "wallpaper__frame", attributes: { alt: "" } }),
      h("img", { className: "wallpaper__frame", attributes: { alt: "" } }),
    ];
    root.prepend(...this.layers);
    const retint = () => {
      if (this.shownSrc !== null) this.tintSurfaces();
    };
    addEventListener("resize", retint);
    // In the stacked layout the page scrolls, and how far depends on what the panel shows.
    new ResizeObserver(retint).observe(document.documentElement);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.dynamicTimer !== undefined) {
        void this.apply(this.choice);
      }
    });
  }

  async apply(choice: BackgroundChoice): Promise<void> {
    const generation = ++this.generation;
    this.choice = choice;
    window.clearInterval(this.dynamicTimer);
    this.dynamicTimer = undefined;

    if (choice.kind === "auto" || choice.kind === "dynamic") {
      const wallpaper = await loadDynamicWallpaper();
      if (generation !== this.generation) return;
      if (wallpaper) {
        const { frame, src } = currentFrame(wallpaper);
        this.root.dataset.frame = String(frame);
        // A hidden tab skips its updates; visibilitychange catches up when it is shown again.
        this.dynamicTimer = window.setInterval(() => {
          if (!document.hidden) void this.apply(this.choice);
        }, DYNAMIC_UPDATE_MS);
        if (await this.show(src, "dynamic")) {
          this.releaseCustomImage(generation);
          return;
        }
        if (generation !== this.generation) return;
      }
    }
    delete this.root.dataset.frame;
    if (choice.kind === "custom") {
      const image = await readCustomBackground(choice.savedAt).catch(
        warnOnFailure("read the uploaded background"),
      );
      if (generation !== this.generation) return;
      if (image && (await this.showCustom(image))) return;
      if (generation !== this.generation) return;
    }
    const photo = choice.kind === "photo" ? choice.photo : DEFAULT_PHOTO;
    await this.show(photoSrc(photo), `photo:${photo}`);
    this.releaseCustomImage(generation);
  }

  private async showCustom(image: Blob): Promise<boolean> {
    const src = URL.createObjectURL(image);
    const shown = await this.show(src, "custom", image);
    if (!shown || this.requestedSrc !== src) {
      URL.revokeObjectURL(src);
      return shown;
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = src;
    return true;
  }

  // Only the latest apply() may free the upload: an older one could free a newer upload's URL.
  private releaseCustomImage(generation: number): void {
    if (generation !== this.generation || this.objectUrl === null) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  /** False only when the image can't be decoded; a superseded image counts as handled. */
  private show(src: string, kind: string, file?: Blob): Promise<boolean> {
    if (this.undecodable.has(src)) return Promise.resolve(false);
    if (src !== this.requestedSrc) {
      this.requestedSrc = src;
      this.requested = this.load(src, kind, file);
    }
    return this.requested;
  }

  private async load(src: string, kind: string, file?: Blob): Promise<boolean> {
    const loader = new Image();
    loader.src = src;
    const measured = measure(file ?? src).catch((error: unknown) => {
      warn(`measure the background ${src}`, error);
      return null;
    });
    try {
      await loader.decode();
    } catch (error: unknown) {
      warn(`load the background ${src}`, error);
      this.undecodable.add(src);
      if (this.requestedSrc === src) {
        // A fallback to the image still on screen must not decode it again and cross-fade it.
        this.requestedSrc = this.shownSrc;
        this.requested = Promise.resolve(true);
      }
      return false;
    }
    const luminance = await measured;
    if (this.requestedSrc !== src) return true;

    const visible = this.layers[this.visibleLayer];
    const next = this.visibleLayer === 0 ? 1 : 0;
    const hidden = this.layers[next];
    // The layer may still be fading out at full opacity: from there the new image would cut in.
    for (const animation of this.root.getAnimations({ subtree: true })) animation.finish();
    hidden.src = src;
    this.shownSrc = src;
    this.shownLuminance = luminance;
    this.tintSurfaces();
    hidden.classList.add("is-visible");
    visible.classList.remove("is-visible");
    this.visibleLayer = next;
    this.root.dataset.background = kind;
    this.root.dataset.state = "ready";
    if (!this.root.classList.contains("is-animated")) {
      // Flush styles so the first, quick fade-in has started before the slow cross-fade applies.
      this.root.getBoundingClientRect();
      this.root.classList.add("is-animated");
    }
    return true;
  }

  private tintSurfaces(): void {
    const tints = this.shownLuminance ? surfaceTints(this.shownLuminance) : null;
    for (const surface of Object.keys(UNTINTED_LIMIT) as Surface[]) {
      const tint = tints?.[surface] ?? FALLBACK_TINT;
      document.documentElement.style.setProperty(`--shade-${surface}`, String(tint));
    }
  }
}
