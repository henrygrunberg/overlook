import { describe, expect, it } from "vitest";
import { sunPosition } from "./solar";

describe("sunPosition", () => {
  it("matches the SunCalc reference position", () => {
    const position = sunPosition(new Date("2013-03-05T00:00:00Z"), 50.5, 30.5);

    // SunCalc reports azimuth -2.5003175907168385 rad from south and altitude -0.7000406838781611 rad.
    expect(position.azimuth).toBeCloseTo(-2.5003175907168385 * (180 / Math.PI) + 180, 6);
    expect(position.altitude).toBeCloseTo(-0.7000406838781611 * (180 / Math.PI), 6);
  });

  it("puts the summer-solstice noon sun due south at the expected height in Tallinn", () => {
    const solarNoon = new Date("2026-06-21T10:20:00Z");
    const position = sunPosition(solarNoon, 59.42, 24.75);

    expect(position.altitude).toBeCloseTo(90 - 59.42 + 23.44, 0);
    expect(position.azimuth).toBeGreaterThan(175);
    expect(position.azimuth).toBeLessThan(185);
  });

  it("has the sun rising in the east and setting in the west", () => {
    const morning = sunPosition(new Date("2026-03-20T06:00:00Z"), 51.48, 0);
    const evening = sunPosition(new Date("2026-03-20T18:00:00Z"), 51.48, 0);

    expect(morning.azimuth).toBeGreaterThan(60);
    expect(morning.azimuth).toBeLessThan(120);
    expect(evening.azimuth).toBeGreaterThan(240);
    expect(evening.azimuth).toBeLessThan(300);
  });

  it("is below the horizon at midnight", () => {
    expect(sunPosition(new Date("2026-10-28T22:00:00Z"), 59.42, 24.75).altitude).toBeLessThan(-30);
  });
});
