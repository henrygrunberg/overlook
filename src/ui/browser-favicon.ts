const FAVICON_SIZE = 64;
const SIGNATURE_SIZE = 16;
// The .invalid TLD can never resolve, so the browser has no icon for it and returns its default.
const UNKNOWN_PAGE = "https://overlook.invalid/";

/** Favicon from the browser's own cache (requires the "favicon" permission). */
export function faviconUrl(pageUrl: string): string {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", String(FAVICON_SIZE));
  return url.href;
}

let signatureContext: OffscreenCanvasRenderingContext2D | null | undefined;

function signature(image: HTMLImageElement): number | null {
  signatureContext ??= new OffscreenCanvas(SIGNATURE_SIZE, SIGNATURE_SIZE).getContext("2d", {
    willReadFrequently: true,
  });
  if (!signatureContext) return null;
  signatureContext.clearRect(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
  signatureContext.drawImage(image, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
  let hash = 0x811c9dc5;
  for (const byte of signatureContext.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE).data) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash;
}

let defaultSignature: Promise<number | null> | undefined;

function defaultFaviconSignature(): Promise<number | null> {
  defaultSignature ??= new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      resolve(signature(image));
    });
    image.addEventListener("error", () => {
      resolve(null);
    });
    image.src = faviconUrl(UNKNOWN_PAGE);
  });
  return defaultSignature;
}

// Every re-render rebuilds the tiles, so each page's favicon would otherwise be read back again.
const verdicts = new Map<string, Promise<boolean>>();

export function isDefaultFavicon(image: HTMLImageElement): Promise<boolean> {
  let verdict = verdicts.get(image.src);
  if (!verdict) {
    verdict = defaultFaviconSignature().then(
      (fallback) => fallback !== null && signature(image) === fallback,
    );
    verdicts.set(image.src, verdict);
  }
  return verdict;
}
