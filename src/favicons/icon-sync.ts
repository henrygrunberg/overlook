import { warn } from "../log";
import { fetchBestIcon, type IconLookup } from "./fetch-icon";
import {
  deleteIcons,
  ICON_CHANNEL,
  iconOrigin,
  needsRefresh,
  readAllIcons,
  readIcon,
  readIconOrigins,
  writeIcon,
  type IconRecord,
} from "./icon-store";

const CONCURRENCY = 4;

export interface IconSyncDeps {
  readonly fetchIcon: (origin: string) => Promise<IconLookup>;
  readonly read: (origin: string) => Promise<IconRecord | undefined>;
  readonly readAll: () => Promise<readonly IconRecord[]>;
  readonly readOrigins: () => Promise<readonly string[]>;
  readonly write: (record: IconRecord) => Promise<void>;
  readonly remove: (origins: readonly string[]) => Promise<void>;
  readonly announce: (origin: string) => void;
  readonly now: () => number;
}

const defaultDeps = (): IconSyncDeps => {
  const channel = new BroadcastChannel(ICON_CHANNEL);
  return {
    fetchIcon: (origin) => fetchBestIcon(origin),
    read: readIcon,
    readAll: readAllIcons,
    readOrigins: readIconOrigins,
    write: writeIcon,
    remove: deleteIcons,
    announce: (origin) => {
      channel.postMessage({ origin });
    },
    now: Date.now,
  };
};

function originsOf(pageUrls: Iterable<string>): Set<string> {
  const origins = new Set<string>();
  for (const url of pageUrls) {
    const origin = iconOrigin(url);
    if (origin) origins.add(origin);
  }
  return origins;
}

export class IconSync {
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];
  private active = 0;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(private readonly deps: IconSyncDeps = defaultDeps()) {}

  async ensure(pageUrls: Iterable<string>, force = false): Promise<void> {
    const requested = [...originsOf(pageUrls)].filter((origin) => !this.pending.has(origin));
    const due = force || requested.length === 0 ? requested : await this.dueOrigins(requested);
    if (due === null) return;
    for (const origin of due) {
      if (this.pending.has(origin)) continue;
      this.pending.add(origin);
      this.queue.push(origin);
    }
    this.pump();
    await this.idle;
  }

  async pruneExcept(pageUrls: Iterable<string>): Promise<void> {
    const kept = originsOf(pageUrls);
    const stale = (await this.deps.readOrigins()).filter(
      (origin) => !kept.has(origin) && !this.pending.has(origin),
    );
    await this.deps.remove(stale);
  }

  private async dueOrigins(origins: readonly string[]): Promise<string[] | null> {
    let records: readonly IconRecord[];
    try {
      // One read of every record beats one transaction per site when a whole library is checked.
      records = await this.deps.readAll();
    } catch (error: unknown) {
      // Every site would look due, and refetching the whole library on each new tab gains nothing.
      warn("read cached icons", error);
      return null;
    }
    const cached = new Map(records.map((record) => [record.origin, record]));
    const now = this.deps.now();
    return origins.filter((origin) => needsRefresh(cached.get(origin), now));
  }

  private pump(): void {
    if (this.queue.length > 0 && this.active === 0 && !this.resolveIdle) {
      this.idle = new Promise((resolve) => (this.resolveIdle = resolve));
    }
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const origin = this.queue.shift();
      if (origin === undefined) break;
      this.active++;
      void this.sync(origin).finally(() => {
        this.active--;
        this.pending.delete(origin);
        this.pump();
      });
    }
    if (this.active === 0 && this.queue.length === 0 && this.resolveIdle) {
      this.resolveIdle();
      this.resolveIdle = undefined;
    }
  }

  private async sync(origin: string): Promise<void> {
    try {
      const lookup = await this.deps.fetchIcon(origin);
      const fetchedAt = this.deps.now();
      if (typeof lookup === "string") {
        await this.saveFailedLookup(origin, lookup, fetchedAt);
        return;
      }
      const { image, fullBleed } = lookup;
      await this.save({ origin, status: "ok", image, fullBleed, fetchedAt });
    } catch (error: unknown) {
      warn(`cache the icon for ${origin}`, error);
    }
  }

  private async saveFailedLookup(
    origin: string,
    failure: Extract<IconLookup, string>,
    fetchedAt: number,
  ): Promise<void> {
    const previous = await this.deps.read(origin);
    const failedAttempts = (previous?.failedAttempts ?? 0) + 1;
    if (failure === "missing" && (!previous || previous.status === "unreachable")) {
      await this.save({ origin, status: "missing", fetchedAt, failedAttempts });
      return;
    }
    // Otherwise open tabs keep what they show: a good icon, a letter, or the browser's favicon.
    await this.deps.write(
      previous
        ? { ...previous, fetchedAt, failedAttempts }
        : { origin, status: "unreachable", fetchedAt, failedAttempts },
    );
  }

  private async save(record: IconRecord): Promise<void> {
    await this.deps.write(record);
    this.deps.announce(record.origin);
  }
}
