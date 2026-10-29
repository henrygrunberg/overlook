import { afterEach, describe, expect, it, vi } from "vitest";
import { clockText, greetingFor, mountClock } from "./clock";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("greetingFor", () => {
  it.each([
    [0, "Good night"],
    [4, "Good night"],
    [5, "Good morning"],
    [11, "Good morning"],
    [12, "Good afternoon"],
    [17, "Good afternoon"],
    [18, "Good evening"],
    [23, "Good evening"],
  ])("greets at %i:00 with %s", (hour, greeting) => {
    expect(greetingFor(hour)).toBe(greeting);
  });
});

describe("clockText", () => {
  it("shows a 24-hour time and the date in the given locale", () => {
    expect(clockText(new Date(2026, 9, 28, 7, 5), "en-GB")).toEqual({
      time: "07:05",
      date: "Wednesday 28 October",
      greeting: "Good morning",
    });
    expect(clockText(new Date(2026, 9, 28, 19, 30), "en-GB").time).toBe("19:30");
  });
});

describe("mountClock", () => {
  it("skips the minute updates while the tab is hidden and catches up when it shows", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 28, 7, 5) });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const root = document.createElement("div");
    mountClock(root);
    const shownTime = () => root.querySelector("time")?.dateTime;
    const mountedAt = shownTime();

    vi.advanceTimersByTime(3 * 60_000);
    expect(shownTime()).toBe(mountedAt);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(shownTime()).toBe(new Date().toISOString());
  });
});
