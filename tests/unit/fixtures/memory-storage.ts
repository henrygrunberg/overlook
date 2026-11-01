import type { ChangeListener, UsageStorage } from "../../../src/usage/usage-store";

// What Chromium hands storage.onChanged listeners: a copy with every object's keys sorted.
function asReported(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asReported);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => [key, asReported(entry)]),
  );
}

/** A storage area shared by every store given it, like chrome.storage.local across tabs. */
export function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const listeners: ChangeListener[] = [];
  let writesToFail = 0;
  const storage: UsageStorage = {
    get: () => Promise.resolve({ ...data }),
    set: (items: Record<string, unknown>) => {
      if (writesToFail > 0) {
        writesToFail--;
        return Promise.reject(new Error("quota exceeded"));
      }
      const changes = Object.fromEntries(
        Object.entries(items).map(([key, newValue]) => [
          key,
          { oldValue: asReported(data[key]), newValue: asReported(newValue) },
        ]),
      );
      Object.assign(data, items);
      void Promise.resolve().then(() => {
        for (const listener of listeners) listener(changes);
      });
      return Promise.resolve();
    },
    onChanged: {
      addListener: (listener: ChangeListener) => {
        listeners.push(listener);
      },
    },
  };
  return {
    storage,
    data,
    failNextWrite: () => {
      writesToFail++;
    },
  };
}
