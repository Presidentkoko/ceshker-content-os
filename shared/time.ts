// Small, dependency-free timezone helpers built on Intl.

function partsIn(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Convert a wall-clock date ("2026-09-22") and time ("10:00") in `timeZone` to a UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes handle DST boundaries.
  let ts = guess - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
  ts = guess - tzOffsetMinutes(new Date(ts), timeZone) * 60000;
  return new Date(ts);
}

/** Wall-clock parts of an instant in `timeZone`, as "YYYY-MM-DD" and "HH:mm". */
export function utcToZonedParts(iso: string | Date, timeZone: string) {
  const p = partsIn(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

export function dayKey(iso: string | Date, timeZone: string) {
  return utcToZonedParts(iso, timeZone).date;
}
