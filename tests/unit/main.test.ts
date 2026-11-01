import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../../src/app";

type SettingsListener = (settings: { focusSearchOnOpen: boolean }) => void;
const subscribers = vi.hoisted(() => [] as SettingsListener[]);
const loadedSettings = vi.hoisted(() => ({
  current: { focusSearchOnOpen: true },
  loadFailed: false,
  subscribe: (listener: SettingsListener) => {
    subscribers.push(listener);
  },
}));
vi.mock("../../src/app", () => ({
  startApp: vi.fn(() => Promise.resolve()),
  showStartupError: vi.fn(),
}));
vi.mock("../../src/settings/settings-store", () => ({
  SettingsStore: { load: () => Promise.resolve(loadedSettings) },
}));

const FOCUS_STEP_ENABLED_KEY = "overlook:focus-search-on-open";

async function loadPage(focusStep?: "leaving") {
  if (focusStep) document.documentElement.dataset.focusStep = focusStep;
  vi.resetModules();
  await import("../../src/main");
  await vi.runAllTimersAsync();
}

describe("main", () => {
  const listeners: [string, EventListenerOrEventListenerObject][] = [];
  const addEventListener = window.addEventListener.bind(window);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(startApp).mockClear();
    vi.spyOn(window, "addEventListener").mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.push([type, listener]);
        addEventListener(type, listener);
      },
    );
  });

  afterEach(() => {
    for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
    delete document.documentElement.dataset.focusStep;
    localStorage.clear();
    subscribers.length = 0;
    Object.assign(loadedSettings, { current: { focusSearchOnOpen: true }, loadFailed: false });
    vi.useRealTimers();
  });

  it("starts the app right away", async () => {
    await loadPage();
    expect(startApp).toHaveBeenCalledOnce();
  });

  it("mirrors the cursor setting for the focus step", async () => {
    loadedSettings.current.focusSearchOnOpen = false;
    await loadPage();
    expect(localStorage.getItem(FOCUS_STEP_ENABLED_KEY)).toBe("false");
  });

  it("keeps the mirrored cursor setting after a fallback to the defaults until it changes", async () => {
    localStorage.setItem(FOCUS_STEP_ENABLED_KEY, "false");
    loadedSettings.loadFailed = true;
    await loadPage();
    expect(localStorage.getItem(FOCUS_STEP_ENABLED_KEY)).toBe("false");
    expect(startApp).toHaveBeenCalledOnce();

    expect(subscribers).toHaveLength(1);
    subscribers[0]?.({ focusSearchOnOpen: true });
    expect(localStorage.getItem(FOCUS_STEP_ENABLED_KEY)).toBe("true");
  });

  it("stays out of the way while the focus step leaves the page", async () => {
    await loadPage("leaving");
    expect(startApp).not.toHaveBeenCalled();
  });

  it("starts after all when the focus step's navigation never happens", async () => {
    await loadPage("leaving");
    window.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(1499);
    expect(startApp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(startApp).toHaveBeenCalledOnce();
  });
});
