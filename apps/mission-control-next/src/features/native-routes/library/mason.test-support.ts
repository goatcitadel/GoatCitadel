import type { BlueprintReviewSummary, CitadelBlueprint, CitadelStructureSnapshot, MasonSession } from "@goatcitadel/contracts";
export const masonTime = "2026-09-30T00:00:00.000Z";
export function masonSession(): MasonSession { return { sessionId: "session-one", answers: {}, status: "collecting", createdAt: masonTime, updatedAt: masonTime }; }
export const masonBlueprint: CitadelBlueprint = { schemaVersion: "goatcitadel.blueprint.v1", metadata: { name: "Reviewed team" },
  charter: { kind: "team", purpose: "Run the team", goals: [], boundaries: [], successDefinition: [], riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded" },
  chambers: [{ name: "General", sensitivity: "private", sealed: false }], riskNotes: [] };
export const masonSummary: BlueprintReviewSummary = { name: "Reviewed team", kind: "team", chamberCount: 1, sealedChamberCount: 0, boundaries: [], riskNotes: [], lines: ["Nothing activates during staging."] };
export function masonStructure(): CitadelStructureSnapshot { return { citadelId: "one", revision: "a".repeat(64), charter: null, chambers: [],
  record: { citadelId: "one", name: "One", slug: "one", kind: "team", lifecycleStatus: "active", revision: "b".repeat(64), createdAt: masonTime, updatedAt: masonTime, hasCharter: false } }; }
export function stagedMasonStructure(before: CitadelStructureSnapshot): CitadelStructureSnapshot { return { ...before, revision: "c".repeat(64), record: before.record ? { ...before.record, hasCharter: true } : undefined,
  charter: { ...masonBlueprint.charter, citadelId: "one", createdAt: masonTime, updatedAt: masonTime },
  chambers: [...before.chambers, { ...masonBlueprint.chambers[0]!, citadelId: "one", chamberId: "new", createdAt: masonTime, updatedAt: masonTime }] }; }
export function deferredMason<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
