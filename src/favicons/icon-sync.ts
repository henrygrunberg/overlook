import { warn, warnOnFailure } from "../log";
import { isPrivateOrigin } from "../private-network";
import { fetchBestIcon, type IconLookup } from "./fetch-icon";
import {
  deleteIcons,
  ICON_CHANNEL,
  iconOrigins,
  needsRefresh,
  readAllIcons,
  readIcon,
  readIconOrigins,
  writeIcon,
  type IconRecord,
} from "./icon-store";
import { allowBookmarkedPrivateSites, blockPrivateSites } from "./private-origin-rules";

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
  readonly allowPrivateSites: () => Promise<void>;
  readonly blockPrivateSites: () => Promise<void>;
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
    allowPrivateSites: allowBookmarkedPrivateSites,
    blockPrivateSites,
  };
};

// The rules that let the extension reach bookmarked private sites can't tell which site a
// redirect came from, so private and public sites are fetched in separate passes.
export class IconSync {
  private readonly pending = new Set<string>();
  private readonly privateQueue: string[] = [];
  private readonly publicQueue: string[] = [];
  private draining = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(private readonly deps: IconSyncDeps = defaultDeps()) {}

  async ensure(pageUrls: Iterable<string>, force = false): Promise<void> {
    const requested = [...iconOrigins(pageUrls)].filter((origin) => !this.pending.has(origin));
    const due = force || requested.length === 0 ? requested : await this.dueOrigins(requested);
    if (due === null) return;
    for (const origin of due) {
      if (this.pending.has(origin)) continue;
      this.pending.add(origin);
      (isPrivateOrigin(origin) ? this.privateQueue : this.publicQueue).push(origin);
    }
    if (!this.draining) {
      this.draining = true;
      this.idle = this.drain();
    }
    await this.idle;
  }

  async pruneExcept(pageUrls: Iterable<string>): Promise<void> {
    const kept = iconOrigins(pageUrls);
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

  private async drain(): Promise<void> {
    try {
      while (this.privateQueue.length > 0 || this.publicQueue.length > 0) {
        if (this.privateQueue.length > 0) await this.runPrivatePass();
        else await this.runPublicPass();
      }
    } finally {
      this.draining = false;
    }
  }

  private async runPrivatePass(): Promise<void> {
    // Sites queued meanwhile wait for the next pass, which allows the bookmarks of that moment.
    const batch = this.privateQueue.splice(0);
    try {
      await this.deps.allowPrivateSites();
    } catch (error: unknown) {
      warn("allow the bookmarked private sites", error);
      this.drop(batch);
      return;
    }
    await this.runAll(batch);
    await this.deps.blockPrivateSites().catch(warnOnFailure("block the private sites again"));
  }

  private async runPublicPass(): Promise<void> {
    try {
      // Also clears what a pass cut short by a stopped worker left allowed.
      await this.deps.blockPrivateSites();
    } catch (error: unknown) {
      warn("block the private sites", error);
      this.drop(this.publicQueue.splice(0));
      return;
    }
    await this.runAll(this.publicQueue);
  }

  private async runAll(queue: string[]): Promise<void> {
    const worker = async () => {
      for (let origin = queue.shift(); origin !== undefined; origin = queue.shift()) {
        await this.sync(origin);
        this.pending.delete(origin);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  private drop(origins: readonly string[]): void {
    for (const origin of origins) this.pending.delete(origin);
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
