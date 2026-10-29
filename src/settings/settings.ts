import { isFiniteNumber, isOneOf, isRecord } from "../validation";

export const LABEL_COLORS = ["green", "blue", "orange", "purple", "red", "gray"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export interface LabelRule {
  readonly id: string;
  readonly text: string;
  readonly color: LabelColor;
  readonly privateNetwork: boolean;
  readonly hosts: readonly string[];
}

export const PHOTO_IDS = ["autumn-forest", "still-lake", "golden-haze", "alpine-ridge"] as const;
export type PhotoId = (typeof PHOTO_IDS)[number];

export type BackgroundChoice =
  | { readonly kind: "auto" }
  | { readonly kind: "dynamic" }
  | { readonly kind: "photo"; readonly photo: PhotoId }
  /** `savedAt` changes with every upload, so replacing the image counts as a settings change. */
  | { readonly kind: "custom"; readonly savedAt: number };

const HOME_SOURCES = ["favourites", "frequent", "folder"] as const;
export type HomeSource = (typeof HOME_SOURCES)[number];

export interface HomeSettings {
  readonly source: HomeSource;
  readonly folderId: string | null;
  readonly showFrequent: boolean;
}

export interface Settings {
  readonly background: BackgroundChoice;
  readonly labels: readonly LabelRule[];
  readonly home: HomeSettings;
  /** Pinned bookmark IDs, in the order shown on Home. */
  readonly favourites: readonly string[];
  readonly focusSearchOnOpen: boolean;
}

const DEFAULT_LABELS: readonly LabelRule[] = [
  { id: "vpn", text: "VPN", color: "green", privateNetwork: true, hosts: [] },
];

export const DEFAULT_SETTINGS: Settings = {
  background: { kind: "auto" },
  labels: DEFAULT_LABELS,
  home: { source: "favourites", folderId: null, showFrequent: true },
  favourites: [],
  focusSearchOnOpen: true,
};

export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 16;
export const MAX_HOST_PATTERNS = 200;
export const MAX_FAVOURITES = 100;
/** No host name is longer, so longer patterns can never match. */
const MAX_HOSTNAME_LENGTH = 253;

function parseBackground(value: unknown): BackgroundChoice {
  if (!isRecord(value)) return DEFAULT_SETTINGS.background;
  switch (value.kind) {
    case "dynamic":
    case "auto":
      return { kind: value.kind };
    case "custom":
      return { kind: "custom", savedAt: isFiniteNumber(value.savedAt) ? value.savedAt : 0 };
    case "photo":
      return isOneOf(PHOTO_IDS, value.photo)
        ? { kind: "photo", photo: value.photo }
        : DEFAULT_SETTINGS.background;
    default:
      return DEFAULT_SETTINGS.background;
  }
}

export function sameBackground(a: BackgroundChoice, b: BackgroundChoice): boolean {
  switch (a.kind) {
    case "auto":
    case "dynamic":
      return b.kind === a.kind;
    case "photo":
      return b.kind === "photo" && a.photo === b.photo;
    case "custom":
      return b.kind === "custom" && a.savedAt === b.savedAt;
  }
}

function parseLabel(value: unknown): LabelRule | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.text !== "string") {
    return null;
  }
  const text = value.text.trim().slice(0, MAX_LABEL_LENGTH);
  if (!text) return null;
  return {
    id: value.id,
    text,
    color: isOneOf(LABEL_COLORS, value.color) ? value.color : "gray",
    privateNetwork: value.privateNetwork === true,
    hosts: Array.isArray(value.hosts)
      ? value.hosts
          .filter((host): host is string => typeof host === "string")
          .map((host) => host.trim().toLowerCase())
          .filter((host) => host.length > 0 && host.length <= MAX_HOSTNAME_LENGTH)
          .slice(0, MAX_HOST_PATTERNS)
      : [],
  };
}

function parseHome(value: unknown): HomeSettings {
  if (!isRecord(value)) return DEFAULT_SETTINGS.home;
  return {
    source: isOneOf(HOME_SOURCES, value.source) ? value.source : DEFAULT_SETTINGS.home.source,
    folderId: typeof value.folderId === "string" ? value.folderId : null,
    showFrequent:
      typeof value.showFrequent === "boolean"
        ? value.showFrequent
        : DEFAULT_SETTINGS.home.showFrequent,
  };
}

function parseFavourites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].slice(0, MAX_FAVOURITES);
}

function uniqueById(labels: readonly LabelRule[]): LabelRule[] {
  const seen = new Set<string>();
  const unique: LabelRule[] = [];
  for (const label of labels) {
    if (seen.has(label.id)) continue;
    seen.add(label.id);
    unique.push(label);
  }
  return unique;
}

export function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) return DEFAULT_SETTINGS;
  return {
    background: parseBackground(value.background),
    labels: Array.isArray(value.labels)
      ? uniqueById(value.labels.map(parseLabel).filter((label) => label !== null)).slice(
          0,
          MAX_LABELS,
        )
      : DEFAULT_SETTINGS.labels,
    home: parseHome(value.home),
    favourites: parseFavourites(value.favourites),
    focusSearchOnOpen:
      typeof value.focusSearchOnOpen === "boolean"
        ? value.focusSearchOnOpen
        : DEFAULT_SETTINGS.focusSearchOnOpen,
  };
}

export function toggleFavourite(favourites: readonly string[], id: string): readonly string[] {
  if (favourites.includes(id)) return favourites.filter((other) => other !== id);
  return favourites.length < MAX_FAVOURITES ? [...favourites, id] : favourites;
}

export function moveFavourite(
  favourites: readonly string[],
  id: string,
  toIndex: number,
): readonly string[] {
  const without = favourites.filter((other) => other !== id);
  if (without.length === favourites.length) return favourites;
  const target = Math.max(0, Math.min(without.length, toIndex));
  return [...without.slice(0, target), id, ...without.slice(target)];
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_IPV6 = /^[\da-f*]*:[\da-f*]*:[\da-f:.*]*$/i;
// Chromium's URL parser percent-encodes `*` in host names, so it is swapped out while parsing.
const WILDCARD_STAND_IN = "overlook-wildcard";

// URL parsing gives the same form as `URL.hostname` on bookmarks: punycode for international
// names, brackets around IPv6, no user, port or path.
function hostPattern(text: string): string {
  const withoutScheme = text.replace(URL_SCHEME, "");
  const authority = BARE_IPV6.test(withoutScheme) ? `[${withoutScheme}]` : withoutScheme;
  try {
    const { hostname } = new URL(`http://${authority.replaceAll("*", WILDCARD_STAND_IN)}`);
    return hostname.replaceAll(WILDCARD_STAND_IN, "*");
  } catch {
    // The parser rejects the stand-in inside IPv6 brackets, so wildcard IPv6 is trimmed by hand.
    return authority
      .replace(/[/?#].*$/, "")
      .replace(/^(\[[^\]]*\]):\d+$/, "$1")
      .toLowerCase();
  }
}

/** Pasted links count by their host: "https://jira.acme.com:8443/browse" → "jira.acme.com". */
export function parseHostPatterns(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map(hostPattern)
    .filter((pattern) => pattern.length > 0 && pattern.length <= MAX_HOSTNAME_LENGTH);
}
