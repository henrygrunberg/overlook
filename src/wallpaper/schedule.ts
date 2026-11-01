import { isFiniteNumber, isRecord } from "../validation";
import type { Coordinates } from "./location";
import { sunPosition } from "./solar";

interface ScheduledFrame {
  readonly frame: number;
  readonly file: string;
}

interface SolarEntry extends ScheduledFrame {
  readonly altitude: number;
  readonly azimuth: number;
}

interface TimeOfDayEntry extends ScheduledFrame {
  /** Start of the frame as a fraction of the local day, 0 = midnight. */
  readonly dayFraction: number;
}

export type WallpaperManifest =
  | { readonly mode: "solar"; readonly schedule: readonly SolarEntry[] }
  | { readonly mode: "time"; readonly schedule: readonly TimeOfDayEntry[] };

const SAFE_FRAME_FILE = /^[\w.-]+\.(?:jpe?g|png|webp|avif)$/i;

function scheduledFrame(
  entry: Record<string, unknown>,
  frames: readonly string[],
): ScheduledFrame | null {
  const { frame } = entry;
  if (typeof frame !== "number" || !Number.isInteger(frame)) return null;
  const file = frames[frame];
  return file === undefined ? null : { frame, file };
}

export function parseManifest(value: unknown): WallpaperManifest {
  if (!isRecord(value) || value.version !== 1) throw new Error("Unsupported wallpaper manifest");
  const { frames, mode, schedule } = value;
  if (
    !Array.isArray(frames) ||
    frames.length === 0 ||
    !frames.every((frame) => typeof frame === "string" && SAFE_FRAME_FILE.test(frame))
  ) {
    throw new Error("Wallpaper manifest has invalid frames");
  }
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error("Wallpaper manifest has no schedule");
  }
  const frameFiles: readonly string[] = frames;

  if (mode === "solar") {
    const entries = schedule.map((entry: unknown): SolarEntry => {
      if (isRecord(entry)) {
        const scheduled = scheduledFrame(entry, frameFiles);
        const { altitude, azimuth } = entry;
        if (
          scheduled &&
          isFiniteNumber(altitude) &&
          isFiniteNumber(azimuth) &&
          azimuth >= 0 &&
          azimuth < 360
        ) {
          return { ...scheduled, altitude, azimuth };
        }
      }
      throw new Error("Wallpaper manifest has an invalid solar entry");
    });
    return { mode, schedule: entries };
  }
  if (mode === "time") {
    const entries = schedule.map((entry: unknown): TimeOfDayEntry => {
      if (isRecord(entry)) {
        const scheduled = scheduledFrame(entry, frameFiles);
        const { dayFraction } = entry;
        if (scheduled && isFiniteNumber(dayFraction) && dayFraction >= 0 && dayFraction <= 1) {
          return { ...scheduled, dayFraction };
        }
      }
      throw new Error("Wallpaper manifest has an invalid time entry");
    });
    return { mode, schedule: entries };
  }
  throw new Error("Wallpaper manifest has an unknown mode");
}

export function localDayFraction(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (value("hour") * 3600 + value("minute") * 60 + value("second")) / 86_400;
}

const isEasternSky = (azimuth: number) => azimuth < 180;

function closest<T>(entries: readonly T[], distance: (entry: T) => number): T {
  return entries.reduce((best, entry) => (distance(entry) < distance(best) ? entry : best));
}

// Schedules are photographed at one place and season, so their azimuths don't carry over to
// other latitudes (in a Nordic summer the sun rises in the north-east). Altitude decides the
// frame; the sun's side of the sky only tells morning frames from evening ones.
function nearestSolarFrame(
  schedule: readonly SolarEntry[],
  date: Date,
  at: Coordinates,
): ScheduledFrame {
  const sun = sunPosition(date, at.latitude, at.longitude);
  const sameSide = schedule.filter(
    (entry) => isEasternSky(entry.azimuth) === isEasternSky(sun.azimuth),
  );
  return closest(sameSide.length > 0 ? sameSide : schedule, (entry) =>
    Math.abs(entry.altitude - sun.altitude),
  );
}

// The frame that started most recently, wrapping past midnight to the previous day's last one.
function currentTimeOfDayFrame(
  schedule: readonly TimeOfDayEntry[],
  date: Date,
  timeZone: string,
): ScheduledFrame {
  const now = localDayFraction(date, timeZone);
  return closest(schedule, (entry) => (now - entry.dayFraction + 1) % 1);
}

export function frameFor(
  manifest: WallpaperManifest,
  date: Date,
  timeZone: string,
  at: Coordinates,
): ScheduledFrame {
  switch (manifest.mode) {
    case "solar":
      return nearestSolarFrame(manifest.schedule, date, at);
    case "time":
      return currentTimeOfDayFrame(manifest.schedule, date, timeZone);
  }
}
