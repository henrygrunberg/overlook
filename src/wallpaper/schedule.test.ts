import { describe, expect, it } from "vitest";
import readme from "../../README.md?raw";
import { coordinatesForTimeZone } from "./location";
import { frameFor, localDayFraction, parseManifest, type WallpaperManifest } from "./schedule";

const BIG_SUR = {
  version: 1,
  mode: "solar",
  frames: [...Array(8).keys()].map((index) => `frame-${index}.jpg`),
  schedule: [
    { frame: 0, altitude: 10, azimuth: 100 },
    { frame: 1, altitude: -25, azimuth: 70 },
    { frame: 2, altitude: -9, azimuth: 80 },
    { frame: 3, altitude: 0, azimuth: 90 },
    { frame: 4, altitude: 25, azimuth: 110 },
    { frame: 4, altitude: 25, azimuth: 250 },
    { frame: 5, altitude: 10, azimuth: 260 },
    { frame: 6, altitude: 0, azimuth: 270 },
    { frame: 7, altitude: -9, azimuth: 280 },
    { frame: 1, altitude: -25, azimuth: 290 },
  ],
};

const TALLINN = "Europe/Tallinn";
const tallinn = coordinatesForTimeZone(TALLINN, new Date("2026-06-21T00:00:00Z"));
const solar = parseManifest(BIG_SUR);
const frameAt = (iso: string) => frameFor(solar, new Date(iso), TALLINN, tallinn).frame;

describe("frameFor (solar)", () => {
  it.each([
    ["white-night twilight", "2026-06-20T21:00:00Z", 7],
    ["sunrise", "2026-06-21T01:10:00Z", 3],
    ["morning", "2026-06-21T03:30:00Z", 0],
    ["midday", "2026-06-21T10:00:00Z", 4],
    ["golden hour", "2026-06-21T18:00:00Z", 5],
    ["sunset", "2026-06-21T19:40:00Z", 6],
  ])("shows the %s frame on the summer solstice in Tallinn", (_label, iso, frame) => {
    expect(frameAt(iso)).toBe(frame);
  });

  it("tells dawn from dusk by the sun's direction", () => {
    expect(frameAt("2026-10-28T04:15:00Z")).toBe(2);
    expect(frameAt("2026-10-28T15:30:00Z")).toBe(7);
  });

  it("shows night in the small hours of a winter morning", () => {
    expect(frameAt("2026-12-21T01:00:00Z")).toBe(1);
  });
});

describe("the README's example manifest", () => {
  const example = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
  const manifest = parseManifest(JSON.parse(example ?? "null"));
  const [dawn, noon, dusk, night] = [0, 1, 2, 3];

  const framesThroughTheDay = (timeZone: string, localMidnightUtc: string) => {
    const at = coordinatesForTimeZone(timeZone, new Date(localMidnightUtc));
    const start = Date.parse(localMidnightUtc);
    const shown: number[] = [];
    for (let minute = 0; minute < 24 * 60; minute += 10) {
      const { frame } = frameFor(manifest, new Date(start + minute * 60_000), timeZone, at);
      if (shown.at(-1) !== frame) shown.push(frame);
    }
    return shown;
  };

  it.each([
    ["Madrid at the spring equinox", "Europe/Madrid", "2026-03-19T23:00:00Z"],
    ["New York at midsummer", "America/New_York", "2026-06-21T04:00:00Z"],
  ])("goes from night through dawn, noon and dusk to night in %s", (_label, timeZone, midnight) => {
    expect(framesThroughTheDay(timeZone, midnight)).toEqual([night, dawn, noon, dusk, night]);
  });
});

describe("frameFor (time of day)", () => {
  const timeManifest: WallpaperManifest = parseManifest({
    version: 1,
    mode: "time",
    frames: ["a.jpg", "b.jpg", "c.jpg"],
    schedule: [
      { frame: 0, dayFraction: 0.25 },
      { frame: 1, dayFraction: 0.5 },
      { frame: 2, dayFraction: 0.8 },
    ],
  });
  const at = coordinatesForTimeZone("UTC", new Date());

  it("uses the latest frame that has started", () => {
    expect(frameFor(timeManifest, new Date("2026-10-28T13:00:00Z"), "UTC", at)).toMatchObject({
      frame: 1,
      file: "b.jpg",
    });
  });

  it("wraps past midnight to the last frame of the previous day", () => {
    expect(frameFor(timeManifest, new Date("2026-10-28T03:00:00Z"), "UTC", at).frame).toBe(2);
  });
});

describe("localDayFraction", () => {
  it("measures the day in the given time zone", () => {
    expect(localDayFraction(new Date("2026-10-28T10:00:00Z"), TALLINN)).toBeCloseTo(12 / 24, 6);
  });
});

describe("parseManifest", () => {
  it("pairs each schedule entry with its frame file", () => {
    expect(solar.mode).toBe("solar");
    expect(solar.schedule[1]).toEqual({
      frame: 1,
      file: "frame-1.jpg",
      altitude: -25,
      azimuth: 70,
    });
  });

  const withFirstFrame = (frame: string) => ({
    ...BIG_SUR,
    frames: BIG_SUR.frames.map((original, index) => (index === 0 ? frame : original)),
  });

  it.each([
    ["an unsupported version", { ...BIG_SUR, version: 2 }, /Unsupported wallpaper manifest/],
    ["a path outside the folder", withFirstFrame("../../etc/passwd.jpg"), /invalid frames/],
    ["an absolute path", withFirstFrame("/abs.jpg"), /invalid frames/],
    ["a URL", withFirstFrame("https://example.com/frame.jpg"), /invalid frames/],
    ["a backslash path", withFirstFrame("a\\b.jpg"), /invalid frames/],
    [
      "a frame index out of range",
      { ...BIG_SUR, schedule: [{ frame: 9, altitude: 0, azimuth: 0 }] },
      /invalid solar entry/,
    ],
    [
      "a non-numeric altitude",
      { ...BIG_SUR, schedule: [{ frame: 0, altitude: "-9", azimuth: 0 }] },
      /invalid solar entry/,
    ],
    [
      "a fractional frame index",
      { ...BIG_SUR, schedule: [{ frame: 0.5, altitude: 0, azimuth: 0 }] },
      /invalid solar entry/,
    ],
    [
      "a day fraction past midnight",
      { ...BIG_SUR, mode: "time", schedule: [{ frame: 0, dayFraction: 1.5 }] },
      /invalid time entry/,
    ],
    ["an unknown mode", { ...BIG_SUR, mode: "appearance" }, /unknown mode/],
    ["an empty schedule", { ...BIG_SUR, schedule: [] }, /no schedule/],
  ])("rejects a manifest with %s", (_label, manifest, message) => {
    expect(() => parseManifest(manifest)).toThrow(message);
  });
});
