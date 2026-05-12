export type OfficeZoneId = "command" | "build" | "research" | "security" | "operations";

export const OFFICE_ZONE_ORDER: OfficeZoneId[] = ["command", "build", "research", "security", "operations"];

interface OfficeZoneSource {
  zoneId?: OfficeZoneId;
  roleId?: string;
  title?: string;
  name?: string;
  summary?: string;
  specialties?: string[];
}

const OFFICE_ZONE_LABELS: Record<OfficeZoneId, string> = {
  command: "Command Deck",
  build: "Build Bay",
  research: "Research Lab",
  security: "Security Watch",
  operations: "Ops Lane",
};

const OFFICE_ZONE_KEYWORDS: Array<{ zoneId: OfficeZoneId; keywords: string[] }> = [
  { zoneId: "research", keywords: ["research", "analysis", "discovery", "sourcing"] },
  { zoneId: "security", keywords: ["security", "safety", "incident", "policy", "guardrail"] },
  { zoneId: "command", keywords: ["architect", "product", "strategy", "scoping", "roadmap", "planner", "planning"] },
  {
    zoneId: "operations",
    keywords: ["ops", "runtime", "reliability", "platform", "deploy", "deployment", "maintenance", "observability"],
  },
  { zoneId: "build", keywords: ["coder", "implementation", "engineer", "qa", "verification", "test", "integration"] },
];

export function officeZoneLabel(zoneId: OfficeZoneId): string {
  return OFFICE_ZONE_LABELS[zoneId];
}

export function inferOfficeZone(source: OfficeZoneSource): OfficeZoneId {
  if (source.zoneId && OFFICE_ZONE_ORDER.includes(source.zoneId)) {
    return source.zoneId;
  }

  const corpus = normalizeOfficeZoneCorpus([
    source.roleId,
    source.title,
    source.name,
    source.summary,
    ...(source.specialties ?? []),
  ]);

  for (const entry of OFFICE_ZONE_KEYWORDS) {
    if (entry.keywords.some((keyword) => corpus.includes(keyword))) {
      return entry.zoneId;
    }
  }

  return "operations";
}

function normalizeOfficeZoneCorpus(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
