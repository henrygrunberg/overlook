import { warn, warnOnFailure } from "../log";
import { DEFAULT_SETTINGS, parseSettings, type Settings } from "./settings";

const STORAGE_KEY = "settings";
// Every tab writes inside this lock, from a fresh read, so one tab's write can't drop another's.
const LOCK_NAME = "overlook-settings";

type SettingsListener = (settings: Settings) => void;
type SettingsChange = (stored: Settings) => Partial<Settings> | Promise<Partial<Settings>>;

async function readStoredSettings(): Promise<Settings> {
  const stored: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return parseSettings(stored);
}

const sameSettings = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);

/** Uses storage.local: storage.sync caps items at 8 KB, which labels with many hosts exceed. */
export class SettingsStore {
  private readonly listeners = new Set<SettingsListener>();
  private settings = DEFAULT_SETTINGS;
  private storedSettingsUnread = true;
  // Reads and writes are numbered as they start (writes as they finish), so a read that started
  // before a newer read or write was adopted can't bring back an older value.
  private sequence = 0;
  private adoptedSequence = 0;

  private constructor() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !(STORAGE_KEY in changes)) return;
      this.read().catch(warnOnFailure("read the changed settings"));
    });
  }

  static async load(): Promise<SettingsStore> {
    const store = new SettingsStore();
    await store.read().catch(warnOnFailure("read settings, using the defaults"));
    return store;
  }

  get current(): Settings {
    return this.settings;
  }

  /** Until a read succeeds, `current` holds the defaults, not what is stored. */
  get loadFailed(): boolean {
    return this.storedSettingsUnread;
  }

  /** Called after changes made in this tab or any other. */
  subscribe(listener: SettingsListener): void {
    this.listeners.add(listener);
  }

  /** `afterSave` runs before any tab can change the settings again. */
  async update(
    change: SettingsChange,
    afterSave?: (saved: Settings) => Promise<void>,
  ): Promise<void> {
    const [saved, sequence] = await navigator.locks.request(LOCK_NAME, async () => {
      const stored = await this.read();
      const next = parseSettings({ ...stored, ...(await change(stored)) });
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      const written = ++this.sequence;
      await afterSave?.(next);
      return [next, written] as const;
    });
    this.adopt(saved, sequence);
  }

  /** For pagehide: the page is gone before a lock or a read would come back. */
  saveNow(change: (current: Settings) => Partial<Settings>): void {
    const next = parseSettings({ ...this.settings, ...change(this.settings) });
    chrome.storage.local.set({ [STORAGE_KEY]: next }).catch(warnOnFailure("save settings"));
  }

  async read(): Promise<Settings> {
    const sequence = ++this.sequence;
    const stored = await readStoredSettings();
    this.adopt(stored, sequence);
    return stored;
  }

  private adopt(settings: Settings, sequence: number): void {
    if (sequence < this.adoptedSequence) return;
    this.adoptedSequence = sequence;
    this.storedSettingsUnread = false;
    if (sameSettings(settings, this.settings)) return;
    this.settings = settings;
    for (const listener of this.listeners) {
      try {
        listener(settings);
      } catch (error: unknown) {
        // The write has landed: a page that failed to show it mustn't make it look lost.
        warn("show the changed settings", error);
      }
    }
  }
}
