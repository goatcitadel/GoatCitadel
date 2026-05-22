import type { UpdateScoutRequest, UpdateScoutReport, UpdateScoutSource } from "@goatcitadel/contracts";

const DEFAULT_WORKSPACE_ID = "default";

export class UpdateScoutService {
  public scout(input: UpdateScoutRequest): UpdateScoutReport {
    const generatedAt = new Date().toISOString();
    return {
      generatedAt,
      workspaceId: input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID,
      appliedUpdates: false,
      items: input.sources.map((source) => buildReportItem(source)),
      warnings: [
        "Update Scout is read-only and did not apply any updates.",
        "Live release probing requires configured provider adapters; this advisory report only normalizes sources and proof lanes.",
      ],
    };
  }
}

export interface UpdateScoutRoutePort {
  scout(input: UpdateScoutRequest): UpdateScoutReport;
}

export class UpdateScoutRouteService {
  public constructor(private readonly port: UpdateScoutRoutePort) {}

  public scout(input: UpdateScoutRequest): UpdateScoutReport {
    return this.port.scout(input);
  }
}

function buildReportItem(source: UpdateScoutSource): UpdateScoutReport["items"][number] {
  const sourceRef = source.sourceRef.trim();
  const sourceType = source.sourceType ?? inferSourceType(sourceRef);
  return {
    sourceRef,
    sourceType,
    currentVersion: source.currentVersion,
    compatibilityNotes: [
      "Review public API/contract changes before adoption.",
      "Keep proposed changes inspectable before callable and route side effects through existing approvals.",
    ],
    risk: sourceType === "skill" ? "medium" : "unknown",
    recommendedProofLanes: proofLanesForSource(sourceType),
    status: "degraded",
    message: "Source normalized for review; no network update probe or install action was performed.",
  };
}

function inferSourceType(sourceRef: string): NonNullable<UpdateScoutSource["sourceType"]> {
  if (/clawhub\.ai|^clawhub:/i.test(sourceRef)) {
    return "skill";
  }
  if (/github\.com|gitlab\.com|bitbucket\.org/i.test(sourceRef)) {
    return "repo";
  }
  if (/^https?:\/\//i.test(sourceRef)) {
    return "url";
  }
  return "package";
}

function proofLanesForSource(sourceType: NonNullable<UpdateScoutSource["sourceType"]>): string[] {
  switch (sourceType) {
    case "skill":
      return [
        "skill import review policy test",
        "capability catalog disposition test",
        "Mission Control Next skill-review display check",
      ];
    case "repo":
      return ["targeted integration tests", "pnpm typecheck", "git diff --check"];
    case "package":
      return ["package-specific tests", "pnpm typecheck", "dependency audit review"];
    case "url":
      return ["docs:check", "operator review of source citations"];
  }
}
