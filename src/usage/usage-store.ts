import { isRecord } from "../validation";

export interface UsageRecord {
  /** Exponentially decaying visit count as of `lastUsed`. */
  readonly score: number;
  readonly lastUsed: number;
}

export type UsageStorage = Pick<chrome.storage.StorageArea, "get" | "set">;

const STORAGE_KEY = "usage";
const HALF_LIFE_MS = 14 * 86_400_000;
const MAX_RECORDS = 500;
const MAX_BOOST = 0.3;

function decayed(record: UsageRecord, now: number): number {
  return record.score * 0.5 ** (Math.max(0, now - record.lastUsed) / HALF_LIFE_MS);
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!isRecord(value)) return false;
  const { score, lastUsed } = value;
  return typeof score === "number" && score > 0 && typeof lastUsed === "number" && lastUsed > 0;
}

async function readRecords(storage: UsageStorage): Promise<Map<string, UsageRecord>> {
  const stored: unknown = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  const records = new Map<string, UsageRecord>();
  if (isRecord(stored)) {
    for (const [url, record] of Object.entries(stored)) {
      if (isUsageRecord(record)) records.set(url, record);
    }
  }
  return records;
}

const memoryOnly: UsageStorage = {
  get: () => Promise.resolve({}),
  set: () => Promise.resolve(),
};

export class UsageStore {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly storage: UsageStorage,
    private records: Map<string, UsageRecord>,
  ) {}

  static async load(storage: UsageStorage): Promise<UsageStore> {
    return new UsageStore(storage, await readRecords(storage));
  }

  static inMemory(): UsageStore {
    return new UsageStore(memoryOnly, new Map());
  }

  frecency(url: string, now = Date.now()): number {
    const record = this.records.get(url);
    return record ? decayed(record, now) : 0;
  }

  boost(url: string, now = Date.now()): number {
    return Math.min(MAX_BOOST, 0.08 * Math.log1p(this.frecency(url, now)));
  }

  mostUsed(
    limit: number,
    now = Date.now(),
    include: (url: string) => boolean = () => true,
  ): string[] {
    return [...this.records.keys()]
      .filter(include)
      .map((url) => ({ url, frecency: this.frecency(url, now) }))
      .sort((a, b) => b.frecency - a.frecency)
      .slice(0, limit)
      .map(({ url }) => url);
  }

  /** Visits are written one at a time, so quick successive clicks can't overwrite each other. */
  recordVisit(url: string, now = Date.now()): Promise<void> {
    const write = this.writes.then(() => this.writeVisit(url, now));
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async writeVisit(url: string, now: number): Promise<void> {
    // Re-read first: other open new-tab pages may have recorded visits since this one loaded.
    const records = await readRecords(this.storage);
    for (const [key, record] of this.records) if (!records.has(key)) records.set(key, record);
    this.records = records;

    this.records.set(url, { score: this.frecency(url, now) + 1, lastUsed: now });
    if (this.records.size > MAX_RECORDS) {
      const keep = new Set(this.mostUsed(MAX_RECORDS, now));
      for (const key of this.records.keys()) if (!keep.has(key)) this.records.delete(key);
    }
    await this.storage.set({ [STORAGE_KEY]: Object.fromEntries(this.records) });
  }
}
