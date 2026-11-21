/** Resolve a selected wall-clock minute without silently normalizing DST gaps
 * or choosing one side of a fold. No new date/time dependency is needed. */
export function resolveFollowThroughLocalTime(value: string, timezone: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("Choose a complete date and time.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number),
    nominal = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 16) !== value)
    throw new Error("Choose a valid calendar date and time.");
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("Choose a supported IANA timezone.");
  }
  const parts = (at: number) => {
    const result = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
    return {
      year: Number(result.year),
      month: Number(result.month),
      day: Number(result.day),
      hour: Number(result.hour),
      minute: Number(result.minute),
    };
  };
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const at = nominal + hours * 3_600_000,
      p = parts(at);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at);
  }
  return [...offsets]
    .map((offset) => nominal - offset)
    .filter((at) => {
      const p = parts(at);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    })
    .sort((a, b) => a - b)
    .map((at) => new Date(at).toISOString());
}
