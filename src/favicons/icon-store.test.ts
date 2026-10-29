import { describe, expect, it } from "vitest";
import { isIconRecord, needsRefresh, type IconRecord } from "./icon-store";

const NOW = Date.UTC(2026, 9, 28);
const DAY = 86_400_000;

const missingIcon = (failedAttempts: number, daysAgo: number): IconRecord => ({
  origin: "https://intranet.example.com",
  status: "missing",
  fetchedAt: NOW - daysAgo * DAY,
  failedAttempts,
});

describe("needsRefresh", () => {
  it("asks for sites it has never checked", () => {
    expect(needsRefresh(undefined, NOW)).toBe(true);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 4],
    [4, 8],
    [5, 16],
    [6, 30],
    [20, 30],
  ])("waits after %i failed checks for %i days", (failedAttempts, days) => {
    expect(needsRefresh(missingIcon(failedAttempts, days - 0.01), NOW)).toBe(false);
    expect(needsRefresh(missingIcon(failedAttempts, days + 0.01), NOW)).toBe(true);
  });

  it("retries a site without an icon after a day when its failed checks weren't counted", () => {
    const uncounted = (daysAgo: number): IconRecord => ({
      origin: "https://intranet.example.com",
      status: "missing",
      fetchedAt: NOW - daysAgo * DAY,
    });
    expect(needsRefresh(uncounted(0.99), NOW)).toBe(false);
    expect(needsRefresh(uncounted(1.01), NOW)).toBe(true);
  });

  it("backs off a cached icon whose refresh failed in the same way", () => {
    const icon: IconRecord = {
      origin: "https://intranet.example.com",
      status: "ok",
      image: new Blob(),
      fullBleed: false,
      fetchedAt: NOW - 3 * DAY,
      failedAttempts: 2,
    };
    expect(needsRefresh(icon, NOW)).toBe(true);
    expect(needsRefresh({ ...icon, failedAttempts: 3 }, NOW)).toBe(false);
  });

  it("refreshes an icon fetched while the clock was set a year ahead", () => {
    const icon: IconRecord = {
      origin: "https://docs.example.com",
      status: "ok",
      image: new Blob(),
      fullBleed: false,
      fetchedAt: NOW + 365 * DAY,
    };
    expect(needsRefresh(icon, NOW)).toBe(true);
  });
});

describe("isIconRecord", () => {
  const icon = {
    origin: "https://docs.example.com",
    status: "ok",
    image: new Blob(),
    fullBleed: false,
    fetchedAt: 1,
  };

  it.each([
    ["a cached icon", icon],
    ["a site without an icon", { origin: icon.origin, status: "missing", fetchedAt: 1 }],
    [
      "a site that was never reached",
      { origin: icon.origin, status: "unreachable", fetchedAt: 1, failedAttempts: 1 },
    ],
    ["a site that failed two checks", { ...icon, failedAttempts: 2 }],
  ])("accepts %s", (_label, record) => {
    expect(isIconRecord(record)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an unknown status", { ...icon, status: "pending" }],
    ["an image that isn't a Blob", { ...icon, image: "data:image/png;base64,AA==" }],
    ["a missing fullBleed", { ...icon, fullBleed: undefined }],
    ["a fullBleed that isn't a boolean", { ...icon, fullBleed: "yes" }],
    ["a non-numeric fetchedAt", { ...icon, fetchedAt: "today" }],
    ["a NaN fetchedAt", { ...icon, fetchedAt: Number.NaN }],
    ["zero failed attempts", { ...icon, failedAttempts: 0 }],
    ["a fractional failed-attempt count", { ...icon, failedAttempts: 1.5 }],
    ["a failed-attempt count as text", { ...icon, failedAttempts: "2" }],
  ])("rejects %s", (_label, record) => {
    expect(isIconRecord(record)).toBe(false);
  });
});
