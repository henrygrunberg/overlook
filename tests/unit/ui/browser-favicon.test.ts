import { beforeEach, describe, expect, it, vi } from "vitest";

const PIXELS = 16 * 16 * 4;
const showsGenericIcon = (src: string) =>
  src.includes("overlook.invalid") || src.includes("intranet");

class LoadingImage extends EventTarget {
  #src = "";
  get src(): string {
    return this.#src;
  }
  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => this.dispatchEvent(new Event("load")));
  }
}

let drawn: string[];
let canvases: number;

class FakeOffscreenCanvas {
  constructor() {
    canvases++;
  }
  getContext() {
    let last = "";
    return {
      clearRect: () => undefined,
      drawImage: (image: { src: string }) => {
        last = image.src;
        drawn.push(image.src);
      },
      getImageData: () => ({
        data: new Uint8ClampedArray(PIXELS).fill(showsGenericIcon(last) ? 0 : 200),
      }),
    };
  }
}

async function loadFavicon() {
  vi.resetModules();
  return import("../../../src/ui/browser-favicon");
}

function tileImage(faviconUrl: (pageUrl: string) => string, pageUrl: string): HTMLImageElement {
  const image = document.createElement("img");
  image.src = faviconUrl(pageUrl);
  return image;
}

beforeEach(() => {
  drawn = [];
  canvases = 0;
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://overlook-test${path}` },
  });
  vi.stubGlobal("Image", LoadingImage);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});

describe("isDefaultFavicon", () => {
  it("tells the browser's generic icon from a site's own favicon", async () => {
    const { faviconUrl, isDefaultFavicon } = await loadFavicon();
    await expect(
      isDefaultFavicon(tileImage(faviconUrl, "https://intranet.acme.com/")),
    ).resolves.toBe(true);
    await expect(isDefaultFavicon(tileImage(faviconUrl, "https://example.com/"))).resolves.toBe(
      false,
    );
  });

  it("reads each page's favicon once, on one reused canvas", async () => {
    const { faviconUrl, isDefaultFavicon } = await loadFavicon();
    await isDefaultFavicon(tileImage(faviconUrl, "https://example.com/"));
    await isDefaultFavicon(tileImage(faviconUrl, "https://example.com/"));
    await isDefaultFavicon(tileImage(faviconUrl, "https://example.org/"));

    expect(drawn).toEqual([
      faviconUrl("https://overlook.invalid/"),
      faviconUrl("https://example.com/"),
      faviconUrl("https://example.org/"),
    ]);
    expect(canvases).toBe(1);
  });
});
