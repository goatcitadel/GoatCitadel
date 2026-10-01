import type { CitadelBrief, CitadelStructureSnapshot, CitadelTemplateSnapshot } from "@goatcitadel/contracts";

export const overviewStructure = (): CitadelStructureSnapshot => ({ citadelId: "one", revision: "a".repeat(64), charter: {
  citadelId: "one", purpose: "Original purpose", kind: "team", goals: ["Goal"], boundaries: ["Boundary"], successDefinition: ["Success"],
  riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded", defaultChamberId: "old", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z",
}, chambers: [{ chamberId: "old", citadelId: "one", name: "Retained", sensitivity: "private", sealed: true, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }] });
export const overviewTemplate: CitadelTemplateSnapshot = { id: "personal-template", revision: "c".repeat(64), name: "Personal", description: "Reviewed template", kind: "personal", purpose: "Template purpose", goals: ["Template goal"], boundaries: [], successDefinition: [], chambers: [{ name: "New Chamber" }] };
export const overviewBrief = (): CitadelBrief => ({ citadelId: "one", citadelName: "Reviewed Citadel", since: "2026-09-29T00:00:00.000Z", generatedAt: "2026-09-30T00:00:00.000Z", workspaces: [{ workspaceId: "workspace-one", name: "Workspace one" }],
  approvals: { pendingCount: 1, oldestAgeMs: 60_000, pending: [{ approvalId: "approval-one", workspaceId: "workspace-one", kind: "tool_invoke", riskLevel: "caution", ageMs: 60_000, createdAt: "2026-09-29T23:59:00.000Z" }] },
  activity: { eventsSince: 2, completedSince: 1, failedSince: 0, wardHitsSince: 0, byType: [] }, spend: { scope: "instance", sinceUsd: 0.1, sinceTokens: 200, complete: false }, memory: { unavailable: "Feature disabled" } });
