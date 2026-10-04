/** Medium date and short time, or an explicit gap when the record has no valid time. */
export function formattedWorkTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Time unavailable";
}
