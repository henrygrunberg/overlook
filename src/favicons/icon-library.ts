import { warn, warnOnFailure } from "../log";
import { isRecord } from "../validation";
import type { IconMessage } from "./icon-messages";
import {
  ICON_CHANNEL,
  iconOrigin,
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

  private constructor(records: readonly IconRecord[]) {
    for (const record of records) this.records.set(record.origin, record);
  }

  static async load(): Promise<IconLibrary> {
    try {
      return new IconLibrary(await readAllIcons());
    } catch (error: unknown) {
      warn("read cached icons", error);
      return new IconLibrary([]);
    }
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
    new BroadcastChannel(ICON_CHANNEL).addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      const origin = isRecord(data) ? data.origin : undefined;
      if (typeof origin !== "string") return;
      void readIcon(origin)
        .then((record) => {
          if (!record) return;
          this.store(record);
          onUpdate(origin);
        })
        .catch(warnOnFailure(`read the icon for ${origin}`));
    });
  }

  request(pageUrls: readonly string[], force = false): void {
    const origins = [...new Set(pageUrls.map(iconOrigin))].filter((origin) => origin !== null);
    const now = Date.now();
    const due = force
      ? origins
      : origins.filter((origin) => needsRefresh(this.records.get(origin), now));
    if (due.length === 0) return;
    const message: IconMessage = { type: force ? "refresh-icons" : "ensure-icons", urls: due };
    chrome.runtime.sendMessage(message).catch(warnOnFailure("reach the icon service worker"));
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
