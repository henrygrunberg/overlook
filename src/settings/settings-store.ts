import { warn } from "../log";
import { DEFAULT_SETTINGS, parseSettings, type Settings } from "./settings";

const STORAGE_KEY = "settings";

type SettingsListener = (settings: Settings) => void;

/** The change was built from stand-in defaults and dropped; the stored settings are now current. */
export class StandInChangeDroppedError extends Error {
  constructor() {
    super("Settings were only just read from storage; make the change again");
  }
}

async function readStoredSettings(): Promise<Settings> {
  const stored: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return parseSettings(stored);
}

// Local updates aren't normalised (untrimmed label text, uppercase hosts), so parse before comparing.
const matchesStored = (stored: Settings, local: Settings) =>
  JSON.stringify(stored) === JSON.stringify(parseSettings(local));

/** Uses storage.local: storage.sync caps items at 8 KB, which labels with many hosts exceed. */
export class SettingsStore {
  private readonly listeners = new Set<SettingsListener>();
  private pendingWrites = 0;
  private version = 0;

  private constructor(
    private settings: Settings,
    private storedSettingsUnread: boolean,
  ) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      const change = changes[STORAGE_KEY];
      if (!change || areaName !== "local") return;
      // While this tab's own writes are in flight, an event may carry an older value than the one
      // already applied here; adopting it would undo the newer change. Storage is read again once
      // the writes are done.
      if (this.pendingWrites === 0) {
        this.settings = parseSettings(change.newValue);
        this.storedSettingsUnread = false;
        this.version++;
      }
      this.notify();
    });
  }

  static async load(): Promise<SettingsStore> {
    try {
      return new SettingsStore(await readStoredSettings(), false);
    } catch (error: unknown) {
      warn("read settings, using the defaults", error);
      return new SettingsStore(DEFAULT_SETTINGS, true);
    }
  }

  get current(): Settings {
    return this.settings;
  }

  get loadFailed(): boolean {
    return this.storedSettingsUnread;
  }

  /** Called after changes made in this tab or any other. */
  subscribe(listener: SettingsListener): void {
    this.listeners.add(listener);
  }

  async update(changes: Partial<Settings>): Promise<void> {
    if (this.storedSettingsUnread) {
      await this.replaceStandInDefaults();
      throw new StandInChangeDroppedError();
    }
    this.settings = { ...this.settings, ...changes };
    this.version++;
    this.pendingWrites++;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: this.settings });
    } finally {
      this.pendingWrites--;
      if (this.pendingWrites === 0) await this.adoptStoredSettings();
    }
  }

  // Until then callers build their changes from the defaults, so saving one (a pin, a label edit)
  // would replace the favourites or labels still in storage. Re-render with those instead.
  private async replaceStandInDefaults(): Promise<void> {
    const stored = await readStoredSettings();
    // An overlapping update or another tab's change got there first, and is newer than this read.
    if (!this.storedSettingsUnread) return;
    this.settings = stored;
    this.storedSettingsUnread = false;
    this.version++;
    this.notify();
  }

  // Catches what the onChanged guard skipped: another tab's write that landed during ours, or our own
  // write that failed (storage then still holds the last value that did save). A change made or
  // adopted while the read is in flight is newer than its result, so that result is dropped.
  private async adoptStoredSettings(): Promise<void> {
    const versionBeforeRead = this.version;
    let stored: Settings;
    try {
      stored = await readStoredSettings();
    } catch (error: unknown) {
      warn("read settings back after saving", error);
      return;
    }
    if (this.version !== versionBeforeRead || matchesStored(stored, this.settings)) return;
    this.settings = stored;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.settings);
  }
}
