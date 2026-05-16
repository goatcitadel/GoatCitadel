/**
 * Pure validators for raw cron-job rows loaded from cron-jobs.json.
 *
 * Shared by:
 *   - services/cron-job-config-helpers.ts (runtime loader; drops malformed rows)
 *   - doctor/engine.ts                    (audit and --fix pruning)
 *
 * These functions MUST stay pure: no logging, no I/O, no side effects.
 * That is what makes them safe to share between the runtime loader and the
 * doctor audit path.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidCronRow(value: unknown): value is { jobId: string; name: string; schedule: string } {
  if (!isPlainRecord(value)) {
    return false;
  }
  const jobId = typeof value.jobId === "string" ? value.jobId.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const schedule = typeof value.schedule === "string" ? value.schedule.trim() : "";
  return Boolean(jobId) && Boolean(name) && Boolean(schedule);
}

export function describeMalformedCronRow(value: unknown): string {
  if (value === null) {
    return "row is null";
  }
  if (typeof value !== "object") {
    return `row is ${typeof value}, not object`;
  }
  if (Array.isArray(value)) {
    return "row is array, not object";
  }
  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof record.jobId !== "string" || record.jobId.trim() === "") {
    issues.push("missing or empty jobId");
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    issues.push("missing or empty name");
  }
  if (typeof record.schedule !== "string" || record.schedule.trim() === "") {
    issues.push("missing or empty schedule");
  }
  return issues.length > 0 ? issues.join(", ") : "row failed validation";
}
