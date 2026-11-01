import { afterEach, describe, expect, it, vi } from "vitest";
import { clockText, greetingFor, mountClock } from "../../../src/ui/clock";

afterEach(() => {
  vi.useRealTimers();
});

describe("greetingFor", () => {
  it.each([
    [0, "Good evening"],
    [4, "Good evening"],
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
  it("ticks on the minute while the tab is visible", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 28, 23, 59, 30) });
    const root = document.createElement("div");
    mountClock(root);
    const shown = (selector: string) => root.querySelector(selector)?.textContent;
    const wednesday = shown(".clock__date");
    expect(shown(".clock__time")).toBe("23:59");

    vi.advanceTimersByTime(30_049);
    expect(shown(".clock__time")).toBe("23:59");
    vi.advanceTimersByTime(2);
    expect(shown(".clock__time")).toBe("00:00");
    expect(shown(".clock__greeting")).toBe("Good evening");
    expect(shown(".clock__date")).not.toBe(wednesday);
  });

  it("marks the date and time with the language they are written in", () => {
    const root = document.createElement("div");
    mountClock(root);
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
    expect(root.querySelector<HTMLElement>(".clock__date")?.lang).toBe(locale);
    expect(root.querySelector<HTMLElement>(".clock__time")?.lang).toBe(locale);
  });

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
