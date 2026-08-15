/**
 * Parse event date/time into an absolute UTC Date for reminders and scheduling.
 *
 * Wall-clock `date` + `time` alone are ambiguous on a UTC server (Heroku):
 * `new Date(y, m, d, h, min)` uses the server's local zone, so a 7 PM Eastern
 * event is treated as 7 PM UTC and reminders fire hours early.
 *
 * Prefer an explicit `startsAt` from the client. Otherwise reconstruct from
 * date + time + timezoneOffsetMinutes, or fall back to EVENT_TIMEZONE
 * (default America/New_York).
 */

const DEFAULT_EVENT_TIMEZONE =
  process.env.EVENT_TIMEZONE || "America/New_York";

type DateParts = {
  year: number;
  monthIndex: number;
  day: number;
};

const parseDateParts = (dateStr: string): DateParts | null => {
  if (!dateStr) {
    return null;
  }

  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      monthIndex: Number(isoMatch[2]) - 1,
      day: Number(isoMatch[3]),
    };
  }

  if (dateStr.includes("/")) {
    const parts = dateStr.split("/");
    if (parts.length === 3) {
      return {
        year: Number(parts[2]),
        monthIndex: Number(parts[0]) - 1,
        day: Number(parts[1]),
      };
    }
  }

  // "Fri Aug 21 2026" / "Aug 21 2026" / "Aug 21, 2026"
  const clean = dateStr.replace(/^[A-Za-z]{3}\s+/, "");
  const monthDayYear = clean.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthDayYear) {
    const probe = new Date(
      `${monthDayYear[1]} ${monthDayYear[2]}, ${monthDayYear[3]}`,
    );
    if (!isNaN(probe.getTime())) {
      return {
        year: probe.getFullYear(),
        monthIndex: probe.getMonth(),
        day: probe.getDate(),
      };
    }
  }

  return null;
};

const parseTimeParts = (
  timeStr?: string,
): { hours: number; minutes: number } => {
  let hours = 0;
  let minutes = 0;
  const timeMatch = timeStr?.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    const period = timeMatch[3]?.toUpperCase();
    if (period === "PM" && hours !== 12) {
      hours += 12;
    } else if (period === "AM" && hours === 12) {
      hours = 0;
    }
  }
  return { hours, minutes };
};

const getZonedParts = (
  ms: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
};

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
export const wallTimeInZoneToUtc = (
  year: number,
  monthIndex: number,
  day: number,
  hours: number,
  minutes: number,
  timeZone: string,
): Date => {
  // Seed with the same components as UTC, then correct by the zone's offset.
  let utc = Date.UTC(year, monthIndex, day, hours, minutes, 0);
  for (let i = 0; i < 3; i++) {
    const got = getZonedParts(utc, timeZone);
    const gotAsUtc = Date.UTC(
      got.year,
      got.month - 1,
      got.day,
      got.hour,
      got.minute,
      0,
    );
    const wantAsUtc = Date.UTC(year, monthIndex, day, hours, minutes, 0);
    utc += wantAsUtc - gotAsUtc;
  }
  return new Date(utc);
};

/**
 * Build an absolute start instant for an event.
 * Prefer `startsAt` when the client already resolved local time.
 */
export const resolveEventStartsAt = (input: {
  startsAt?: string | Date | null;
  date?: string;
  time?: string;
  /** From `Date.getTimezoneOffset()` — minutes to add to local to get UTC. */
  timezoneOffsetMinutes?: number | null;
  timeZone?: string;
}): Date | null => {
  if (input.startsAt) {
    const direct = new Date(input.startsAt);
    if (!isNaN(direct.getTime())) {
      return direct;
    }
  }

  if (!input.date) {
    return null;
  }

  const dateParts = parseDateParts(input.date);
  if (!dateParts) {
    return null;
  }
  const { hours, minutes } = parseTimeParts(input.time);

  if (
    typeof input.timezoneOffsetMinutes === "number" &&
    Number.isFinite(input.timezoneOffsetMinutes)
  ) {
    // Local wall clock expressed as UTC components, then shift by the
    // creator's offset (same convention as Date.getTimezoneOffset()).
    const asUtcMs = Date.UTC(
      dateParts.year,
      dateParts.monthIndex,
      dateParts.day,
      hours,
      minutes,
      0,
    );
    return new Date(asUtcMs + input.timezoneOffsetMinutes * 60 * 1000);
  }

  return wallTimeInZoneToUtc(
    dateParts.year,
    dateParts.monthIndex,
    dateParts.day,
    hours,
    minutes,
    input.timeZone || DEFAULT_EVENT_TIMEZONE,
  );
};

export default {
  resolveEventStartsAt,
  wallTimeInZoneToUtc,
};
