import { describe, expect, it } from "vitest";
import { coordinatesForTimeZone, utcOffsetMinutes } from "../../../src/wallpaper/location";

const october = new Date("2026-10-28T12:00:00Z");

describe("coordinatesForTimeZone", () => {
  it("uses the tz database location of the zone", () => {
    expect(coordinatesForTimeZone("Europe/Tallinn", october)).toEqual({
      latitude: 59.42,
      longitude: 24.75,
    });
  });

  it.each([
    ["Europe/Kiev", "Europe/Kyiv"],
    ["Africa/Asmera", "Africa/Asmara"],
    ["Pacific/Truk", "Pacific/Chuuk"],
    ["EST5EDT", "America/New_York"],
    ["CST6CDT", "America/Chicago"],
    ["MST7MDT", "America/Denver"],
    ["PST8PDT", "America/Los_Angeles"],
  ])("places the older zone name %s where %s is", (legacy, current) => {
    expect(coordinatesForTimeZone(legacy, october)).toEqual(
      coordinatesForTimeZone(current, october),
    );
  });

  it("estimates the longitude from the UTC offset for zones without a location", () => {
    expect(coordinatesForTimeZone("Etc/GMT-3", october).longitude).toBe(45);
    expect(coordinatesForTimeZone("UTC", october).longitude).toBe(0);
  });
});

describe("utcOffsetMinutes", () => {
  it("follows daylight saving time", () => {
    expect(utcOffsetMinutes("Europe/Tallinn", new Date("2026-07-01T12:00:00Z"))).toBe(180);
    expect(utcOffsetMinutes("Europe/Tallinn", new Date("2026-12-01T12:00:00Z"))).toBe(120);
    expect(utcOffsetMinutes("America/St_Johns", new Date("2026-12-01T12:00:00Z"))).toBe(-210);
  });
});
