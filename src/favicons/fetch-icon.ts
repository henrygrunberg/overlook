import { isPrivateNetworkHost, isPrivateOrigin } from "../private-network";
import { parseHttpUrl } from "../validation";
import {
  conventionalIcons,
  findManifestIcons,
  findPageIcons,
  hasHeadEnded,
  rankIcons,
  type IconCandidate,
} from "./discover";
import { imageSize } from "./image-size";

const PAGE_BYTE_LIMIT = 512 * 1024;
const MANIFEST_BYTE_LIMIT = 64 * 1024;
const IMAGE_BYTE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 3000;
const MAX_ATTEMPTS = 6;
/** Icons are stored at this size; tiles show them at up to 38 CSS px on 2× screens. */
const STORED_ICON_SIZE = 128;
/** Anything smaller would look blurry, so a letter tile is shown instead. */
const MIN_ICON_SIZE = 32;
const GOOD_ENOUGH_SIZE = 96;
const MAX_DECODED_SIZE = 4096;

export interface FetchedIcon {
  readonly image: Blob;
  /** The icon covers its whole square (like an app icon), so it can fill the tile. */
  readonly fullBleed: boolean;
}

/** "unreachable": neither the site's page nor its favicon got a response (offline, off the VPN). */
export type IconLookup = FetchedIcon | "missing" | "unreachable";

type Fetch = typeof fetch;

interface Download<Body> {
  readonly body: Body;
  readonly type: string;
  readonly url: string;
}

type DownloadResult<Body> = Download<Body> | "failed" | "unreachable";

type BodyReader<Body> = (response: Response) => Promise<Body | null>;

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readCapped(limit: number): BodyReader<Uint8Array<ArrayBuffer>> {
  return async ({ body, headers }) => {
    if (!body) return null;
    if (Number(headers.get("content-length") ?? 0) > limit) {
      await body.cancel();
      return null;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return concat(chunks, total);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  };
}

const HEAD_END = /<\/head[\s>]/i;
// The tag can be split across chunks, so the search starts this far back in what came before.
const HEAD_END_OVERLAP = "</head".length;

// Icon links sit in <head>, so a long page is cut off at the limit instead of thrown away.
const readHead: BodyReader<string> = async ({ body }) => {
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let total = 0;
  let headEndSeen = false;
  let nextScanAt = 0;
  while (total < PAGE_BYTE_LIMIT) {
    const { done, value } = await reader.read();
    if (done) return html + decoder.decode();
    const kept = value.subarray(0, PAGE_BYTE_LIMIT - total);
    total += kept.byteLength;
    const searchFrom = Math.max(0, html.length - HEAD_END_OVERLAP);
    html += decoder.decode(kept, { stream: true });
    headEndSeen ||= HEAD_END.test(html.slice(searchFrom));
    // The full scan runs only once "</head" turns up, and after a decoy (one in a comment or
    // script) not again until the page has doubled, so the scans add up to linear time.
    if (headEndSeen && html.length >= nextScanAt) {
      if (hasHeadEnded(html)) break;
      headEndSeen = false;
      nextScanAt = html.length * 2;
    }
  }
  await reader.cancel();
  return html;
};

const discardBody: BodyReader<never> = async ({ body }) => {
  await body?.cancel();
  return null;
};

// Pages choose their own icon URLs and could aim them at the LAN. Other hosts must be public, and
// for a public site also https: a router can't prove it owns a public name that resolves to it.
export function isPermittedIconUrl(url: string, siteOrigin: string): boolean {
  const target = parseHttpUrl(url);
  if (!target) return false;
  if (target.origin === siteOrigin) return true;
  if (isPrivateNetworkHost(target.hostname)) return false;
  return target.protocol === "https:" || isPrivateOrigin(siteOrigin);
}

// Only the site's own URLs follow redirects. The declarativeNetRequest rules stop hops to private
// addresses but not to a public name that resolves to one, so a public site's response must also
// end somewhere its page could have linked to.
function redirectPolicy(url: string, siteOrigin: string): RequestRedirect {
  return new URL(url).origin === siteOrigin ? "follow" : "error";
}

function isPermittedLanding(finalUrl: string, siteOrigin: string): boolean {
  return isPrivateOrigin(siteOrigin) || isPermittedIconUrl(finalUrl, siteOrigin);
}

async function get<Body>(
  fetchImpl: Fetch,
  url: string,
  siteOrigin: string,
  accept: string,
  read: BodyReader<Body>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<DownloadResult<Body>> {
  if (!isPermittedIconUrl(url, siteOrigin)) return "failed";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: redirectPolicy(url, siteOrigin),
      headers: { Accept: accept },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "unreachable";
  }
  const finalUrl = response.url || url;
  if (!response.ok || !isPermittedLanding(finalUrl, siteOrigin)) {
    response.body?.cancel().catch(() => undefined);
    return "failed";
  }
  const body = await read(response).catch(() => null);
  return body === null
    ? "failed"
    : { body, type: response.headers.get("content-type") ?? "", url: finalUrl };
}

async function fetchManifestIcons(
  fetchImpl: Fetch,
  manifestUrl: string,
  origin: string,
): Promise<IconCandidate[]> {
  const manifest = await get(
    fetchImpl,
    manifestUrl,
    origin,
    "application/json",
    readCapped(MANIFEST_BYTE_LIMIT),
  );
  if (typeof manifest === "string") return [];
  try {
    return findManifestIcons(JSON.parse(new TextDecoder().decode(manifest.body)), manifest.url);
  } catch {
    return [];
  }
}

// A host can be up while its page never settles: a slow first byte, or a redirect loop that
// only a cookie would end. Most such hosts still serve their favicon directly.
async function isReachable(origin: string, fetchImpl: Fetch): Promise<boolean> {
  const probe = await get(
    fetchImpl,
    `${origin}/favicon.ico`,
    origin,
    "image/*",
    discardBody,
    PROBE_TIMEOUT_MS,
  );
  return probe !== "unreachable";
}

const bareHost = (url: string) => new URL(url).hostname.replace(/^www\./, "");

// Requests carry no cookies, so a site behind a sign-in redirects to its login page, whose icons
// are the login provider's. Only a page on the site's own host speaks for the site.
function isOnSite(pageUrl: string, origin: string): boolean {
  return bareHost(pageUrl) === bareHost(origin);
}

export async function discoverIcons(
  origin: string,
  fetchImpl: Fetch,
): Promise<IconCandidate[] | "unreachable"> {
  const page = await get(fetchImpl, `${origin}/`, origin, "text/html", readHead);
  if (page === "unreachable" && !(await isReachable(origin, fetchImpl))) return "unreachable";
  const candidates: IconCandidate[] = [];
  if (typeof page !== "string" && page.type.includes("html") && isOnSite(page.url, origin)) {
    const { icons, manifestUrl } = findPageIcons(page.body, page.url);
    candidates.push(...icons);
    if (manifestUrl) candidates.push(...(await fetchManifestIcons(fetchImpl, manifestUrl, origin)));
  }
  return rankIcons([...candidates, ...conventionalIcons(origin)]).filter((candidate) =>
    isPermittedIconUrl(candidate.url, origin),
  );
}

function hasOpaqueCorners(context: OffscreenCanvasRenderingContext2D): boolean {
  const { width: size } = context.canvas;
  const near = Math.round(size * 0.04);
  const far = size - 1 - near;
  const { data } = context.getImageData(0, 0, size, size);
  const isOpaque = (x: number, y: number) => (data[(y * size + x) * 4 + 3] ?? 0) > 250;
  return isOpaque(near, near) && isOpaque(far, near) && isOpaque(near, far) && isOpaque(far, far);
}

function hasUsableSize({ width, height }: ImageBitmap): boolean {
  return Math.min(width, height) >= MIN_ICON_SIZE && Math.max(width, height) <= MAX_DECODED_SIZE;
}

function drawCentred(bitmap: ImageBitmap): OffscreenCanvasRenderingContext2D | null {
  const context = new OffscreenCanvas(STORED_ICON_SIZE, STORED_ICON_SIZE).getContext("2d");
  if (!context) return null;
  const scale = STORED_ICON_SIZE / Math.max(bitmap.width, bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    (STORED_ICON_SIZE - width) / 2,
    (STORED_ICON_SIZE - height) / 2,
    width,
    height,
  );
  return context;
}

export async function normalizeIcon(
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
): Promise<(FetchedIcon & { readonly sourceSize: number }) | null> {
  // The byte limit doesn't bound the decoded size (a 30 KB PNG can declare 16000×16000 pixels),
  // and createImageBitmap decodes in full before its size can be checked, so the header is read
  // first. A format without a known header isn't decoded at all.
  const declared = imageSize(bytes);
  if (!declared || Math.max(declared.width, declared.height) > MAX_DECODED_SIZE) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: type || "image/x-icon" }));
  } catch {
    return null;
  }
  const sourceSize = Math.min(bitmap.width, bitmap.height);
  const context = hasUsableSize(bitmap) ? drawCentred(bitmap) : null;
  bitmap.close();
  if (!context) return null;
  return {
    image: await context.canvas.convertToBlob({ type: "image/png" }),
    fullBleed: hasOpaqueCorners(context),
    sourceSize,
  };
}

export async function fetchBestIcon(origin: string, fetchImpl: Fetch = fetch): Promise<IconLookup> {
  const candidates = await discoverIcons(origin, fetchImpl);
  if (candidates === "unreachable") return "unreachable";
  let best: (FetchedIcon & { readonly sourceSize: number }) | null = null;
  for (const candidate of candidates.slice(0, MAX_ATTEMPTS)) {
    const download = await get(
      fetchImpl,
      candidate.url,
      origin,
      "image/*",
      readCapped(IMAGE_BYTE_LIMIT),
    );
    if (typeof download === "string") continue;
    const icon = await normalizeIcon(download.body, download.type);
    if (icon && icon.sourceSize > (best?.sourceSize ?? 0)) best = icon;
    if (best && best.sourceSize >= GOOD_ENOUGH_SIZE) break;
  }
  return best ? { image: best.image, fullBleed: best.fullBleed } : "missing";
}
