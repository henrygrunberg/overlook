import { isRecord } from "../validation";

export interface IconCandidate {
  readonly url: string;
  /** Declared size in pixels; 0 when the page doesn't say. */
  readonly size: number;
}

export interface PageIcons {
  readonly icons: readonly IconCandidate[];
  readonly manifestUrl: string | null;
}

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const APPLE_TOUCH_ICON_SIZE = 180;
// Service workers can't rasterise SVG, so vector icons are skipped in favour of bitmaps.
const SVG = /\.svgz?(?:[?#]|$)/i;

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

const MAX_CODE_POINT = 0x10ffff;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity: string, code: string) => {
    if (!code.startsWith("#")) return ENTITIES[code.toLowerCase()] ?? entity;
    const codePoint = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    // Out-of-range references would make fromCodePoint throw; leave them as written.
    return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
  });
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, double, single, bare] of tag.slice(5).matchAll(ATTRIBUTE)) {
    if (name) attributes.set(name.toLowerCase(), decodeEntities(double ?? single ?? bare ?? ""));
  }
  return attributes;
}

/** "16x16 32x32" → 32, "any" → 512 (scalable), missing → 0. */
export function largestDeclaredSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  let largest = 0;
  for (const size of sizes.toLowerCase().split(/\s+/)) {
    if (size === "any") return 512;
    const [width = 0, height = 0] = size.split("x").map(Number);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      largest = Math.max(largest, Math.min(width, height));
    }
  }
  return largest;
}

function resolveHttpUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function findPageIcons(html: string, pageUrl: string): PageIcons {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const icons: IconCandidate[] = [];
  let manifestUrl: string | null = null;

  // An unclosed <link would make every later <link scan to the end of the head.
  const scanned = head.slice(0, head.lastIndexOf(">") + 1);
  for (const [tag] of scanned.matchAll(LINK_TAG)) {
    const attributes = parseAttributes(tag);
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attributes.get("href");
    if (!href) continue;
    const url = resolveHttpUrl(href, pageUrl);
    if (!url) continue;

    if (rel.includes("manifest")) {
      manifestUrl ??= url;
      continue;
    }
    const isAppleTouch =
      rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!isAppleTouch && !rel.includes("icon")) continue;
    if (attributes.get("type") === "image/svg+xml" || SVG.test(url)) continue;

    const declared = largestDeclaredSize(attributes.get("sizes"));
    icons.push({ url, size: declared || (isAppleTouch ? APPLE_TOUCH_ICON_SIZE : 0) });
  }
  return { icons, manifestUrl };
}

export function findManifestIcons(manifest: unknown, manifestUrl: string): IconCandidate[] {
  if (!isRecord(manifest)) return [];
  const { icons } = manifest;
  if (!Array.isArray(icons)) return [];

  return icons.flatMap((icon: unknown): IconCandidate[] => {
    if (!isRecord(icon)) return [];
    const { src, sizes, type, purpose } = icon;
    if (typeof src !== "string" || type === "image/svg+xml" || SVG.test(src)) return [];
    if (typeof purpose === "string" && purpose.split(/\s+/).includes("monochrome")) return [];
    const url = resolveHttpUrl(src, manifestUrl);
    return url ? [{ url, size: largestDeclaredSize(typeof sizes === "string" ? sizes : "") }] : [];
  });
}

export function conventionalIcons(origin: string): IconCandidate[] {
  return [
    { url: `${origin}/apple-touch-icon.png`, size: APPLE_TOUCH_ICON_SIZE },
    { url: `${origin}/favicon.ico`, size: 0 },
  ];
}

const IDEAL_SIZE = 192;

export function rankIcons(candidates: readonly IconCandidate[]): IconCandidate[] {
  const bySize = new Map<string, IconCandidate>();
  for (const candidate of candidates) {
    const existing = bySize.get(candidate.url);
    if (!existing || candidate.size > existing.size) bySize.set(candidate.url, candidate);
  }
  const bucket = ({ size }: IconCandidate) =>
    size >= 96 ? 0 : size >= 48 ? 1 : size === 0 ? 2 : 3;
  const withinBucket = (a: IconCandidate, b: IconCandidate) =>
    bucket(a) === 0
      ? Math.abs(a.size - IDEAL_SIZE) - Math.abs(b.size - IDEAL_SIZE)
      : b.size - a.size;
  return [...bySize.values()].sort((a, b) => bucket(a) - bucket(b) || withinBucket(a, b));
}
