// Sun position after the formulas in Astronomy Answers (also used by SunCalc); accurate to
// well under a degree, which is far finer than the wallpaper schedules need.

const RADIANS = Math.PI / 180;
const DAY_MS = 86_400_000;
const JULIAN_1970 = 2_440_588;
const JULIAN_2000 = 2_451_545;
const EARTH_OBLIQUITY = RADIANS * 23.4397;

export interface SunPosition {
  /** Degrees above the horizon; negative below it. */
  readonly altitude: number;
  /** Compass bearing in degrees: 0 north, 90 east, 180 south, 270 west. */
  readonly azimuth: number;
}

function daysSinceJ2000(date: Date): number {
  return date.getTime() / DAY_MS - 0.5 + JULIAN_1970 - JULIAN_2000;
}

function eclipticLongitude(meanAnomaly: number): number {
  const center =
    RADIANS *
    (1.9148 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly) +
      0.0003 * Math.sin(3 * meanAnomaly));
  const perihelion = RADIANS * 102.9372;
  return meanAnomaly + center + perihelion + Math.PI;
}

export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition {
  const days = daysSinceJ2000(date);
  const meanAnomaly = RADIANS * (357.5291 + 0.98560028 * days);
  const longitudeOnEcliptic = eclipticLongitude(meanAnomaly);

  const declination = Math.asin(Math.sin(EARTH_OBLIQUITY) * Math.sin(longitudeOnEcliptic));
  const rightAscension = Math.atan2(
    Math.sin(longitudeOnEcliptic) * Math.cos(EARTH_OBLIQUITY),
    Math.cos(longitudeOnEcliptic),
  );

  const siderealTime = RADIANS * (280.16 + 360.9856235 * days) + RADIANS * longitude;
  const hourAngle = siderealTime - rightAscension;
  const phi = RADIANS * latitude;

  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(declination) +
      Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle),
  );
  const azimuthFromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi),
  );

  return {
    altitude: altitude / RADIANS,
    azimuth: (azimuthFromSouth / RADIANS + 180 + 360) % 360,
  };
}
