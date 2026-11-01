import {
  deleteRecords,
  getAllKeys,
  getAllRecords,
  getRecord,
  putRecord,
} from "../storage/database";
import { isFiniteNumber, isRecord, parseHttpUrl } from "../validation";

interface IconCheck {
  readonly origin: string;
  readonly fetchedAt: number;
  /** Consecutive checks that found no usable icon, or couldn't reach the site. */
  readonly failedAttempts?: number;
}

export type IconRecord =
  | (IconCheck & { readonly status: "ok"; readonly image: Blob; readonly fullBleed: boolean })
  | (IconCheck & { readonly status: "missing" })
  // No check has reached the site yet, so nothing is known about its icon.
  | (IconCheck & { readonly status: "unreachable" });

export const ICON_CHANNEL = "overlook-icons";

const DAY_MS = 86_400_000;
const REFRESH_AFTER_MS = 30 * DAY_MS;
// Failed checks back off to 1, 2, 4 … days: a missing icon rarely appears overnight, and an
// unreachable host (often an intranet site off the VPN) shouldn't reach the network's DNS daily.
const MAX_BACKOFF_MS = 30 * DAY_MS;

export function iconOrigin(pageUrl: string): string | null {
  return parseHttpUrl(pageUrl)?.origin ?? null;
}

export function iconOrigins(pageUrls: Iterable<string>): Set<string> {
  const origins = new Set<string>();
  for (const url of pageUrls) {
    const origin = iconOrigin(url);
    if (origin) origins.add(origin);
  }
  return origins;
}

function retryAfter(record: IconRecord): number {
  const failedAttempts = record.failedAttempts ?? 0;
  return failedAttempts > 0
    ? Math.min(2 ** (failedAttempts - 1) * DAY_MS, MAX_BACKOFF_MS)
    : REFRESH_AFTER_MS;
}

// A check dated in the future means the clock was ahead then; waiting for it could take years.
export function needsRefresh(record: IconRecord | undefined, now = Date.now()): boolean {
  return !record || record.fetchedAt > now || now - record.fetchedAt > retryAfter(record);
}

function isAttemptCount(value: unknown): boolean {
  return value === undefined || (isFiniteNumber(value) && Number.isInteger(value) && value > 0);
}

export function isIconRecord(value: unknown): value is IconRecord {
  if (!isRecord(value)) return false;
  if (typeof value.origin !== "string" || !isFiniteNumber(value.fetchedAt)) return false;
  if (!isAttemptCount(value.failedAttempts)) return false;
  return (
    value.status === "missing" ||
    value.status === "unreachable" ||
    (value.status === "ok" && value.image instanceof Blob && typeof value.fullBleed === "boolean")
  );
}

export async function readIcon(origin: string): Promise<IconRecord | undefined> {
  const record = await getRecord("icons", origin);
  return isIconRecord(record) ? record : undefined;
}

export async function readAllIcons(): Promise<IconRecord[]> {
  return (await getAllRecords("icons")).filter(isIconRecord);
}

export async function readIconOrigins(): Promise<string[]> {
  return getAllKeys("icons");
}

export async function writeIcon(record: IconRecord): Promise<void> {
  await putRecord("icons", record);
}

export async function deleteIcons(origins: readonly string[]): Promise<void> {
  await deleteRecords("icons", origins);
}
