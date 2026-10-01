export function createScheduleJobId(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `manual-${slug || "schedule"}-${Date.now().toString(36)}`;
}
