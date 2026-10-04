import type { CapabilityUsage } from "./capability-catalog";

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formattedDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function CapabilityLastUsed({ usage }: { usage: CapabilityUsage }) {
  // One vocabulary: "not tracked" (no counter for this kind), "could not be checked" (read failed),
  // "no recorded use" (tracked, never used), or a time.
  if (usage.status === "unsupported") return <>Usage not tracked for this type</>;
  if (usage.status === "unavailable") return <>Last use could not be checked</>;
  if (usage.status === "not_recorded") return <>No recorded use</>;
  const date = validDate(usage.lastUsedAt);
  if (date) return <>Last used <time dateTime={usage.lastUsedAt}>{formattedDate(date)}</time></>;
  if (usage.usageCount === 0) return <>No recorded use</>;
  return <>Used; time not recorded</>;
}

export function CapabilityUsageEvidence({ usage }: { usage: CapabilityUsage }) {
  if (usage.status === "unsupported") return <p>Usage evidence is not provided for this capability type.</p>;
  if (usage.status === "unavailable") return <p>Skill usage could not be verified from the current skills list.</p>;
  if (usage.status === "not_recorded") return <p>The current skills list has no usage count or last-used time for this skill.</p>;
  const date = validDate(usage.lastUsedAt);
  return <div className="space-y-2">
    <p>Recorded uses: {usage.usageCount === undefined ? "Not recorded" : usage.usageCount}</p>
    <p>Last used: {date ? <time dateTime={usage.lastUsedAt}>{formattedDate(date)}</time> : "Not recorded"}</p>
    <p className="text-xs text-fg-muted">These are skill lifecycle counters from Gateway. They are not a complete history of every tool or capability invocation.</p>
  </div>;
}
