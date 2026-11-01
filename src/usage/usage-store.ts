import { warn } from "../log";
import { isFiniteNumber, isRecord } from "../validation";

export interface UsageRecord {
  /** Exponentially decaying visit count as of `lastUsed`. */
  readonly score: number;
  readonly lastUsed: number;
}

export type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>) => void;

export interface UsageStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  readonly onChanged: { addListener(listener: ChangeListener): void };
}

const STORAGE_KEY = "usage";
// Every tab records inside this lock, from a fresh read, so one tab's visit can't drop another's.
const LOCK_NAME = "overlook-usage";
const HALF_LIFE_MS = 14 * 86_400_000;
const MAX_RECORDS = 500;
// Keeps the history to a few MB of the storage quota it shares with the settings.
const MAX_URL_LENGTH = 8192;
const MAX_BOOST = 0.3;

type Records = ReadonlyMap<string, UsageRecord>;

function decayed(record: UsageRecord, now: number): number {
  return record.score * 0.5 ** (Math.max(0, now - record.lastUsed) / HALF_LIFE_MS);
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!isRecord(value)) return false;
  const { score, lastUsed } = value;
  return isFiniteNumber(score) && score > 0 && isFiniteNumber(lastUsed) && lastUsed > 0;
}

function parseRecords(stored: unknown): Map<string, UsageRecord> {
  const records = new Map<string, UsageRecord>();
  if (!isRecord(stored)) return records;
  const now = Date.now();
  for (const [url, record] of Object.entries(stored)) {
    if (url.length > MAX_URL_LENGTH || !isUsageRecord(record)) continue;
    // Written while the clock was ahead: it would otherwise not fade until that time comes.
    records.set(url, { score: record.score, lastUsed: Math.min(record.lastUsed, now) });
  }
  return records;
}

// Not by their JSON: Chromium reports a stored value back with its keys sorted.
function sameRecords(a: Records, b: Records): boolean {
  if (a.size !== b.size) return false;
  for (const [url, record] of a) {
    const other = b.get(url);
    if (other?.score !== record.score || other.lastUsed !== record.lastUsed) return false;
  }
  return true;
}

async function readRecords(storage: UsageStorage): Promise<Map<string, UsageRecord>> {
  return parseRecords((await storage.get(STORAGE_KEY))[STORAGE_KEY]);
}

function mostUsedOf(
  records: Records,
  limit: number,
  now: number,
  include: (url: string) => boolean = () => true,
): string[] {
  return [...records]
    .filter(([url]) => include(url))
    .map(([url, record]) => ({ url, frecency: decayed(record, now) }))
    .sort((a, b) => b.frecency - a.frecency)
    .slice(0, limit)
    .map(({ url }) => url);
}

export class UsageStore {
  private readonly listeners = new Set<() => void>();
  private records: Records = new Map();
  // Storage reports this tab's own writes too; they aren't news to it.
  private lastWritten: Records | undefined;

  private constructor(private readonly storage: UsageStorage) {
    storage.onChanged.addListener((changes) => {
      const change = changes[STORAGE_KEY];
      if (!change) return;
      this.records = parseRecords(change.newValue);
      if (this.lastWritten && sameRecords(this.records, this.lastWritten)) return;
      for (const listener of this.listeners) listener();
    });
  }

  /** A history that can't be read starts empty; new visits are still saved. */
  static async load(storage: UsageStorage): Promise<UsageStore> {
    const store = new UsageStore(storage);
    const unread = store.records;
    try {
      const records = await readRecords(storage);
      // A change heard while reading is newer than what the read returned.
      if (store.records === unread) store.records = records;
    } catch (error: unknown) {
      warn("read usage history; Frequent starts empty", error);
    }
    return store;
  }

  /** Called after visits recorded in other tabs. */
  subscribe(listener: () => void): void {
    this.listeners.add(listener);
  }

  frecency(url: string, now = Date.now()): number {
    const record = this.records.get(url);
    return record ? decayed(record, now) : 0;
  }

  boost(url: string, now = Date.now()): number {
    return Math.min(MAX_BOOST, 0.08 * Math.log1p(this.frecency(url, now)));
  }

  mostUsed(limit: number, now = Date.now(), include?: (url: string) => boolean): string[] {
    return mostUsedOf(this.records, limit, now, include);
  }

  recordVisit(url: string, now = Date.now()): Promise<void> {
    if (url.length > MAX_URL_LENGTH) return Promise.resolve();
    return navigator.locks.request(LOCK_NAME, async () => {
      const records = await readRecords(this.storage);
      const record = records.get(url);
      records.set(url, { score: (record ? decayed(record, now) : 0) + 1, lastUsed: now });
      if (records.size > MAX_RECORDS) {
        const others = (other: string) => other !== url;
        const kept = new Set(mostUsedOf(records, MAX_RECORDS - 1, now, others));
        for (const key of records.keys()) if (others(key) && !kept.has(key)) records.delete(key);
      }
      this.lastWritten = records;
      await this.storage.set({ [STORAGE_KEY]: Object.fromEntries(records) });
      this.records = records;
    });
  }
}
