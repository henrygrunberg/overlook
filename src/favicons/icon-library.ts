import { warn, warnOnFailure } from "../log";
import { isRecord } from "../validation";
import { MAX_MESSAGE_URLS, type IconMessage } from "./icon-messages";
import {
  ICON_CHANNEL,
  iconOrigin,
  iconOrigins,
  needsRefresh,
  readAllIcons,
  readIcon,
  type IconRecord,
} from "./icon-store";

export type IconState =
  | { readonly kind: "image"; readonly src: string; readonly fullBleed: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

export interface IconSource {
  iconFor(pageUrl: string): IconState;
}

type CachedIcon = Extract<IconRecord, { status: "ok" }>;

export class IconLibrary implements IconSource {
  private readonly records = new Map<string, IconRecord>();
  // Object URLs are made on first use: a new tab shows a few dozen of possibly thousands.
  private readonly imageUrls = new Map<string, string>();
  private readonly announcedBeforeWatch = new Set<string>();
  private onUpdate: ((origin: string) => void) | undefined;

  // Listening starts before the cache is read: the service worker announces each icon only once.
  private constructor() {
    new BroadcastChannel(ICON_CHANNEL).addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      const origin = isRecord(data) ? data.origin : undefined;
      if (typeof origin !== "string") return;
      if (this.onUpdate) this.refresh(origin);
      else this.announcedBeforeWatch.add(origin);
    });
  }

  static async load(): Promise<IconLibrary> {
    const library = new IconLibrary();
    try {
      for (const record of await readAllIcons()) library.records.set(record.origin, record);
    } catch (error: unknown) {
      warn("read cached icons", error);
    }
    return library;
  }

  iconFor(pageUrl: string): IconState {
    const origin = iconOrigin(pageUrl);
    const record = origin === null ? undefined : this.records.get(origin);
    if (!record || record.status === "unreachable") return { kind: "unknown" };
    if (record.status === "missing") return { kind: "none" };
    return { kind: "image", src: this.imageUrl(record), fullBleed: record.fullBleed };
  }

  hasCachedIcon(origin: string): boolean {
    return this.records.get(origin)?.status === "ok";
  }

  watch(onUpdate: (origin: string) => void): void {
    this.onUpdate = onUpdate;
    for (const origin of this.announcedBeforeWatch) this.refresh(origin);
    this.announcedBeforeWatch.clear();
  }

  private refresh(origin: string): void {
    void readIcon(origin)
      .then((record) => {
        if (!record) return;
        this.store(record);
        this.onUpdate?.(origin);
      })
      .catch(warnOnFailure(`read the icon for ${origin}`));
  }

  request(pageUrls: readonly string[], force = false): void {
    const now = Date.now();
    const due = [...iconOrigins(pageUrls)].filter(
      (origin) => force || needsRefresh(this.records.get(origin), now),
    );
    const type = force ? "refresh-icons" : "ensure-icons";
    for (let start = 0; start < due.length; start += MAX_MESSAGE_URLS) {
      const message: IconMessage = { type, urls: due.slice(start, start + MAX_MESSAGE_URLS) };
      chrome.runtime.sendMessage(message).catch(warnOnFailure("reach the icon service worker"));
    }
  }

  private imageUrl(record: CachedIcon): string {
    let url = this.imageUrls.get(record.origin);
    if (url === undefined) {
      url = URL.createObjectURL(record.image);
      this.imageUrls.set(record.origin, url);
    }
    return url;
  }

  private store(record: IconRecord): void {
    const previousUrl = this.imageUrls.get(record.origin);
    if (previousUrl !== undefined) URL.revokeObjectURL(previousUrl);
    this.imageUrls.delete(record.origin);
    this.records.set(record.origin, record);
  }
}
