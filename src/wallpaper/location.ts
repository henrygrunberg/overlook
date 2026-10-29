import { TIME_ZONE_COORDINATES } from "./timezone-coordinates";

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

// Used when a zone has no tz database location (e.g. "Etc/GMT+3"): the UTC offset still gives
// a good longitude, and a mid-northern latitude is where most people using the zone live.
const FALLBACK_LATITUDE = 40;

export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function utcOffsetMinutes(timeZone: string, date: Date): number {
  const offsetName = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetName ?? "");
  if (!match) return 0;
  const [, sign, hours, minutes] = match;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
}

/** Approximates the user's location from their time zone, so no location permission is needed. */
export function coordinatesForTimeZone(timeZone: string, date: Date): Coordinates {
  const known = TIME_ZONE_COORDINATES[timeZone];
  if (known) return { latitude: known[0], longitude: known[1] };
  return { latitude: FALLBACK_LATITUDE, longitude: utcOffsetMinutes(timeZone, date) / 4 };
}
