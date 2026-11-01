import { isRecord, parseHttpUrl } from "../validation";

export interface IconCandidate {
  readonly url: string;
  /** Declared size in pixels; 0 when the page doesn't say. */
  readonly size: number;
}

export interface PageIcons {
  readonly icons: readonly IconCandidate[];
  readonly manifestUrl: string | null;
}

const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TAG_NAME = /<(\/?)([a-z][^\s/>]*)/iy;
// Their content is text to the HTML parser, however much it looks like markup.
const RAW_TEXT_END = new Map(
  ["script", "style", "title", "textarea", "noscript", "template"].map((name) => [
    name,
    new RegExp(`</${name}[\\s/>]`, "gi"),
  ]),
);
const APPLE_TOUCH_ICON_SIZE = 180;
// Service workers can't rasterise SVG, so vector icons are skipped in favour of bitmaps.
const SVG = /\.svgz?(?:[?#]|$)/i;

const ENTITIES = new Map([
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
]);

const MAX_CODE_POINT = 0x10ffff;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity: string, code: string) => {
    if (!code.startsWith("#")) return ENTITIES.get(code.toLowerCase()) ?? entity;
    const codePoint = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    // Out-of-range references would make fromCodePoint throw; leave them as written.
    return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTE)) {
    if (name) attributes.set(name.toLowerCase(), decodeEntities(double ?? single ?? bare ?? ""));
  }
  return attributes;
}

interface Tag {
  readonly name: string;
  readonly isEnd: boolean;
  readonly attributes: string;
}

const QUOTED_VALUE = /=\s*(?:"[^"]*"|'[^']*')/y;

// The ">" that closes a tag, skipping any inside quoted values; -1 if the tag never closes.
function tagEnd(html: string, from: number): number {
  let at = from;
  while (at < html.length && html[at] !== ">") {
    QUOTED_VALUE.lastIndex = at;
    at = QUOTED_VALUE.test(html) ? QUOTED_VALUE.lastIndex : at + 1;
  }
  return at < html.length ? at : -1;
}

// A bounded stand-in for the HTML tokenizer: comments and raw text yield no tags, and an
// unclosed tag or comment ends the scan, as it would end the document.
function* tags(html: string): Generator<Tag> {
  let at = 0;
  while ((at = html.indexOf("<", at)) !== -1) {
    if (html.startsWith("<!--", at)) {
      const close = html.indexOf("-->", at + 2);
      if (close === -1) return;
      at = close + 3;
      continue;
    }
    TAG_NAME.lastIndex = at;
    const match = TAG_NAME.exec(html);
    if (!match) {
      // "<!doctype …>" and "<?xml …>" run to the next ">"; any other "<" is text.
      at = "!?/".includes(html[at + 1] ?? " ") ? html.indexOf(">", at) : at + 1;
      if (at === -1) return;
      continue;
    }
    const end = tagEnd(html, TAG_NAME.lastIndex);
    if (end === -1) return;
    const [, slash, name = ""] = match;
    const tag = {
      name: name.toLowerCase(),
      isEnd: slash === "/",
      attributes: html.slice(TAG_NAME.lastIndex, end),
    };
    yield tag;
    at = end + 1;
    const rawTextEnd = tag.isEnd ? undefined : RAW_TEXT_END.get(tag.name);
    if (rawTextEnd) {
      rawTextEnd.lastIndex = at;
      const close = rawTextEnd.exec(html);
      if (!close) return;
      at = close.index;
    }
  }
}

const isHeadEnd = (tag: Tag) => tag.isEnd && tag.name === "head";

export function hasHeadEnded(html: string): boolean {
  for (const tag of tags(html)) if (isHeadEnd(tag)) return true;
  return false;
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

const resolveHttpUrl = (href: string, base: string) => parseHttpUrl(href, base)?.href ?? null;

export function findPageIcons(html: string, pageUrl: string): PageIcons {
  const links: Map<string, string>[] = [];
  let baseHref: string | undefined;
  for (const tag of tags(html)) {
    if (isHeadEnd(tag)) break;
    if (tag.isEnd) continue;
    if (tag.name === "link") links.push(parseAttributes(tag.attributes));
    if (tag.name === "base") baseHref ??= parseAttributes(tag.attributes).get("href");
  }
  const base = (baseHref === undefined ? null : resolveHttpUrl(baseHref, pageUrl)) ?? pageUrl;

  const icons: IconCandidate[] = [];
  let manifestUrl: string | null = null;
  for (const attributes of links) {
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attributes.get("href");
    if (!href) continue;
    const url = resolveHttpUrl(href, base);
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

const GENERAL_PURPOSES = new Set(["any", "maskable"]);

// A monochrome-only icon is a silhouette meant to be tinted, which would show as a blot.
function hasGeneralPurpose(purpose: unknown): boolean {
  if (typeof purpose !== "string") return true;
  const purposes = purpose.toLowerCase().split(/\s+/).filter(Boolean);
  return purposes.length === 0 || purposes.some((name) => GENERAL_PURPOSES.has(name));
}

export function findManifestIcons(manifest: unknown, manifestUrl: string): IconCandidate[] {
  if (!isRecord(manifest)) return [];
  const { icons } = manifest;
  if (!Array.isArray(icons)) return [];

  return icons.flatMap((icon: unknown): IconCandidate[] => {
    if (!isRecord(icon)) return [];
    const { src, sizes, type, purpose } = icon;
    if (typeof src !== "string" || type === "image/svg+xml" || SVG.test(src)) return [];
    if (!hasGeneralPurpose(purpose)) return [];
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
