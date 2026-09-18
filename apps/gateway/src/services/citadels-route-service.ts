import { createHash } from "node:crypto";
import type {
  BlueprintReviewSummary,
  Citadel,
  CitadelAccessMutation,
  CitadelAccessSnapshot,
  CitadelBlueprint,
  CitadelBlueprintValidationResult,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharterInput,
  CitadelCreateInput,
  CitadelCouncilAssignment,
  CitadelCouncilAssignmentInput,
  CitadelGatehouseSummary,
  CitadelIntegrationGrant,
  CitadelIntegrationGrantInput,
  CitadelLifecycleStatus,
  CitadelMember,
  CitadelMemberInput,
  MasonAnswers,
  MasonSession,
  ModelUsageAttributionContext,
  CitadelPassage,
  CitadelPassageInput,
  CitadelRecord,
  CitadelStructureMutation,
  CitadelStructureSnapshot,
  CitadelTemplate,
  CitadelTemplateSnapshot,
  CitadelUpdateInput,
  CitadelVaultMutation,
  CitadelVaultSnapshot,
  CitadelVaultSecretMetadata,
  CitadelVaultSecretRecord,
  CitadelWardInput,
  CitadelWardRecord,
  WardEffect,
} from "@goatcitadel/contracts";
import {
  buildMasonInterpretPrompt,
  CITADEL_TEMPLATES,
  ConflictError,
  createCitadelBlueprintMutation,
  createCitadelTemplateMutation,
  draftBlueprintFromAnswers,
  evaluateWards,
  masonSessionCanDraft,
  exportCitadelBlueprint,
  findCitadelTemplate,
  generateBlueprintReviewSummary,
  MASON_SETUP_QUESTIONS,
  parseMasonInterpretResponse,
  summarizeCitadelGatehouse,
  validateCitadelBlueprint,
} from "@goatcitadel/contracts";
import { openValue, sealValue } from "@goatcitadel/contracts/citadel-vault-node";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

/** Interprets a freeform message into raw model output (the Mason's one LLM dependency). */
export type MasonInterpret = (prompt: string, attribution: ModelUsageAttributionContext) => Promise<string>;

/**
 * Resolves the per-Citadel Vault master key. Returns undefined when the secret
 * store is unavailable — the Vault then fails closed (never plaintext fallback).
 */
export type VaultKeyProvider = (citadelId: string) => Buffer | undefined;

export type VaultStoreResult = { ok: false; reason: "unavailable" } | { ok: true; snapshot: CitadelVaultSnapshot };

export type VaultRevealResult = { ok: false; reason: "unavailable" | "not_found" } | { ok: true; value: string };

export type CitadelImportResult = { ok: false; errors: string[] } | { ok: true; citadel: CitadelStructureSnapshot };

export type MasonReviewResult = { ok: false; errors: string[] } | { ok: true; review: BlueprintReviewSummary };

export type MasonStageResult =
  | { ok: false; errors: string[] }
  | { ok: true; citadel: CitadelStructureSnapshot; review: BlueprintReviewSummary };

export type MasonDraftResult =
  | { ok: false; reason: "not_found" | "incomplete" }
  | { ok: true; blueprint: CitadelBlueprint };

export type MasonMessageResult =
  | { ok: false; reason: "not_found" | "no_interpreter" }
  | { ok: true; session: MasonSession };

/**
 * Minimal port over the Citadel persistence layer (satisfied structurally by the
 * storage CitadelRepository) so routes depend on behaviour, not the concrete repo.
 */
export interface CitadelsRoutePort {
  listRecords(view?: CitadelLifecycleStatus | "all", limit?: number): Promise<CitadelRecord[]>;
  getRecord(citadelId: string): Promise<CitadelRecord>;
  createRecord(input: CitadelCreateInput): Promise<CitadelRecord>;
  updateRecord(citadelId: string, input: CitadelUpdateInput): Promise<CitadelRecord>;
  archiveRecord(citadelId: string, expectedRevision: string): Promise<CitadelRecord>;
  restoreRecord(citadelId: string, expectedRevision: string): Promise<CitadelRecord>;
  getCitadel(citadelId: string): Promise<Citadel | undefined>;
  getStructureSnapshot(citadelId: string): Promise<CitadelStructureSnapshot>;
  mutateStructure(input: CitadelStructureMutation): Promise<CitadelStructureSnapshot>;
  getAccessSnapshot(citadelId: string): Promise<CitadelAccessSnapshot>;
  mutateAccess(input: CitadelAccessMutation): Promise<CitadelAccessSnapshot>;
  listChambers(citadelId: string): Promise<CitadelChamber[]>;
  listCouncilAssignments(citadelId: string): Promise<CitadelCouncilAssignment[]>;
  listWards(citadelId: string): Promise<CitadelWardRecord[]>;
  listPassages(sourceCitadelId: string): Promise<CitadelPassage[]>;
  listMembers(citadelId: string): Promise<CitadelMember[]>;
  createMasonSession(): Promise<MasonSession>;
  getMasonSession(sessionId: string): Promise<MasonSession | undefined>;
  updateMasonSessionAnswers(sessionId: string, patch: Partial<MasonAnswers>): Promise<MasonSession | undefined>;
  setMasonSessionStatus(sessionId: string, status: MasonSession["status"]): Promise<MasonSession | undefined>;
  listIntegrationGrants(citadelId: string): Promise<CitadelIntegrationGrant[]>;
  getVaultSnapshot(citadelId: string): Promise<CitadelVaultSnapshot>;
  mutateVault(input: CitadelVaultMutation): Promise<CitadelVaultSnapshot>;
  getVaultSecret(citadelId: string, secretId: string): Promise<CitadelVaultSecretRecord | undefined>;
}

export class CitadelsRouteService {
  public constructor(
    private readonly citadels: CitadelsRoutePort,
    private readonly masonInterpret?: MasonInterpret,
    private readonly vaultKey?: VaultKeyProvider,
  ) {}

  public async listRecords(view: CitadelLifecycleStatus | "all" = "active", limit = 200): Promise<CitadelRecord[]> {
    return await this.citadels.listRecords(view, limit);
  }

  public async getRecord(citadelId: string): Promise<CitadelRecord> {
    return await this.citadels.getRecord(citadelId);
  }

  public async createRecord(input: CitadelCreateInput): Promise<CitadelRecord> {
    return await this.citadels.createRecord(input);
  }

  public async updateRecord(citadelId: string, input: CitadelUpdateInput): Promise<CitadelRecord> {
    return await this.citadels.updateRecord(citadelId, input);
  }

  public async archiveRecord(citadelId: string, expectedRevision: string): Promise<CitadelRecord> {
    return await this.citadels.archiveRecord(citadelId, expectedRevision);
  }

  public async restoreRecord(citadelId: string, expectedRevision: string): Promise<CitadelRecord> {
    return await this.citadels.restoreRecord(citadelId, expectedRevision);
  }

  public async getCitadel(citadelId: string): Promise<Citadel | undefined> {
    return await this.citadels.getCitadel(citadelId);
  }

  public async getStructureSnapshot(citadelId: string): Promise<CitadelStructureSnapshot> {
    return await this.citadels.getStructureSnapshot(citadelId);
  }

  public async getAccessSnapshot(citadelId: string): Promise<CitadelAccessSnapshot> {
    return await this.citadels.getAccessSnapshot(citadelId);
  }

  public async upsertCharter(input: CitadelCharterInput & { expectedRevision: string }): Promise<CitadelStructureSnapshot> {
    const { citadelId, expectedRevision, ...charter } = input;
    return await this.citadels.mutateStructure({ citadelId, expectedRevision, change: { type: "charter", charter } });
  }

  public async createChamber(input: CitadelChamberInput & { expectedRevision: string }): Promise<CitadelStructureSnapshot> {
    const { citadelId, expectedRevision, ...chamber } = input;
    return await this.citadels.mutateStructure({ citadelId, expectedRevision, change: { type: "chamber", chamber } });
  }

  public async listChambers(citadelId: string): Promise<CitadelChamber[]> {
    return await this.citadels.listChambers(citadelId);
  }

  public listTemplates(): CitadelTemplateSnapshot[] {
    return CITADEL_TEMPLATES.map(snapshotTemplate);
  }

  public async createFromTemplate(citadelId: string, templateId: string, expectedRevision: string, expectedTemplateRevision: string): Promise<CitadelStructureSnapshot | undefined> {
    const template = findCitadelTemplate(templateId);
    if (!template) {
      return undefined;
    }
    const reviewed = snapshotTemplate(template);
    if (reviewed.revision !== expectedTemplateRevision) {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "This template changed. Review its current contents before applying it.",
        details: { reason: "CITADEL_TEMPLATE_REVISION_CONFLICT" } });
    }
    return await this.citadels.mutateStructure(createCitadelTemplateMutation(citadelId, expectedRevision, reviewed));
  }

  public async exportBlueprint(citadelId: string): Promise<CitadelBlueprint | undefined> {
    const citadel = await this.citadels.getCitadel(citadelId);
    if (!citadel) {
      return undefined;
    }
    return exportCitadelBlueprint(citadel);
  }

  public validateBlueprint(value: unknown): CitadelBlueprintValidationResult {
    return validateCitadelBlueprint(value);
  }

  public async createFromBlueprint(citadelId: string, value: unknown, expectedRevision: string): Promise<CitadelImportResult> {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, citadel: await this.citadels.mutateStructure(createCitadelBlueprintMutation(citadelId, expectedRevision, value as CitadelBlueprint)) };
  }

  public async getGatehouse(citadelId: string): Promise<(CitadelGatehouseSummary & { wardCount: number }) | undefined> {
    const citadel = await this.citadels.getCitadel(citadelId);
    if (!citadel) {
      return undefined;
    }
    return { ...summarizeCitadelGatehouse(citadel), wardCount: (await this.citadels.listWards(citadelId)).length };
  }

  public async listWards(citadelId: string): Promise<CitadelWardRecord[]> {
    return await this.citadels.listWards(citadelId);
  }

  public async addWard(input: CitadelWardInput & { expectedRevision: string }): Promise<CitadelAccessSnapshot> {
    const { citadelId, expectedRevision, ...ward } = input;
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "add_ward", ward } });
  }

  public async removeWard(citadelId: string, wardId: string, expectedRevision: string): Promise<CitadelAccessSnapshot> {
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "remove_ward", wardId } });
  }

  /** Vault secret names + provenance — never the sealed or opened value. */
  public async listVaultSecrets(citadelId: string): Promise<CitadelVaultSecretMetadata[]> {
    return (await this.citadels.getVaultSnapshot(citadelId)).items;
  }

  public async getVaultSnapshot(citadelId: string): Promise<CitadelVaultSnapshot> {
    return await this.citadels.getVaultSnapshot(citadelId);
  }

  /** Seal a plaintext under the Citadel's master key and persist it. Fails closed if no key. */
  public async storeVaultSecret(citadelId: string, secretName: string, plaintext: string, expectedRevision: string): Promise<VaultStoreResult> {
    const key = this.vaultKey?.(citadelId);
    if (!key) {
      return { ok: false, reason: "unavailable" };
    }
    const snapshot = await this.citadels.mutateVault({
      citadelId, expectedRevision,
      change: { type: "store", secretName, sealedValue: sealValue(plaintext, key) },
    });
    return { ok: true, snapshot };
  }

  /** Open a stored secret with the Citadel's master key. Fails closed if no key or undecryptable. */
  public async revealVaultSecret(citadelId: string, secretId: string): Promise<VaultRevealResult> {
    const key = this.vaultKey?.(citadelId);
    if (!key) {
      return { ok: false, reason: "unavailable" };
    }
    const record = await this.citadels.getVaultSecret(citadelId, secretId);
    if (!record) {
      return { ok: false, reason: "not_found" };
    }
    try {
      return { ok: true, value: openValue(record.sealedValue, key) };
    } catch {
      // Wrong key or tampered envelope — never leak ciphertext or a partial result.
      return { ok: false, reason: "unavailable" };
    }
  }

  public async deleteVaultSecret(citadelId: string, secretId: string, expectedRevision: string): Promise<CitadelVaultSnapshot> {
    return await this.citadels.mutateVault({ citadelId, expectedRevision, change: { type: "delete", secretId } });
  }

  /** The Council is the set of existing agents assigned to this Citadel (by id). */
  public async listCouncil(citadelId: string): Promise<CitadelCouncilAssignment[]> {
    return await this.citadels.listCouncilAssignments(citadelId);
  }

  public async assignAgent(input: CitadelCouncilAssignmentInput & { expectedRevision: string }): Promise<CitadelAccessSnapshot> {
    const { citadelId, expectedRevision, ...assignment } = input;
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "assign_agent", assignment } });
  }

  public async unassignAgent(citadelId: string, agentId: string, expectedRevision: string): Promise<CitadelAccessSnapshot> {
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "unassign_agent", agentId } });
  }

  public async listPassages(sourceCitadelId: string): Promise<CitadelPassage[]> {
    return await this.citadels.listPassages(sourceCitadelId);
  }

  public async createPassage(input: CitadelPassageInput & { expectedRevision: string }): Promise<CitadelAccessSnapshot> {
    const { sourceCitadelId: citadelId, expectedRevision, ...passage } = input;
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "create_passage", passage } });
  }

  public async removePassage(citadelId: string, passageId: string, expectedRevision: string): Promise<CitadelAccessSnapshot> {
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "remove_passage", passageId } });
  }

  public async listMembers(citadelId: string): Promise<CitadelMember[]> {
    return await this.citadels.listMembers(citadelId);
  }

  public async upsertMember(input: CitadelMemberInput & { expectedRevision: string }): Promise<CitadelAccessSnapshot> {
    const { citadelId, expectedRevision, ...member } = input;
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "upsert_member", member } });
  }

  public async removeMember(citadelId: string, subjectId: string, expectedRevision: string): Promise<CitadelAccessSnapshot> {
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "remove_member", subjectId } });
  }

  // --- The Mason: deterministic setup surface (§9/§10). Stages, never activates. ---

  public getMasonSetupQuestions(): readonly string[] {
    return MASON_SETUP_QUESTIONS;
  }

  /** Deterministically draft a Blueprint from structured setup answers (§9.4). */
  public draftBlueprint(answers: MasonAnswers): CitadelBlueprint {
    return draftBlueprintFromAnswers(answers);
  }

  // --- Mason sessions (§22.2): accumulate answers, then draft. ---

  public async createMasonSession(): Promise<MasonSession> {
    return await this.citadels.createMasonSession();
  }

  public async getMasonSession(sessionId: string): Promise<MasonSession | undefined> {
    return await this.citadels.getMasonSession(sessionId);
  }

  public async updateMasonSessionAnswers(
    sessionId: string,
    patch: Partial<MasonAnswers>,
  ): Promise<MasonSession | undefined> {
    return await this.citadels.updateMasonSessionAnswers(sessionId, patch);
  }

  public async draftFromSession(sessionId: string): Promise<MasonDraftResult> {
    const session = await this.citadels.getMasonSession(sessionId);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }
    if (!masonSessionCanDraft(session)) {
      return { ok: false, reason: "incomplete" };
    }
    const blueprint = draftBlueprintFromAnswers(session.answers as MasonAnswers);
    await this.citadels.setMasonSessionStatus(sessionId, "drafted");
    return { ok: true, blueprint };
  }

  /**
   * Process a freeform message in a Mason session: build the extraction prompt, call
   * the model (if configured), strictly parse the result, and merge it into the
   * session's accumulated answers. Degrades gracefully when no model is configured.
   */
  public async interpretSessionMessage(sessionId: string, message: string): Promise<MasonMessageResult> {
    const session = await this.citadels.getMasonSession(sessionId);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }
    if (!this.masonInterpret) {
      return { ok: false, reason: "no_interpreter" };
    }
    const prompt = buildMasonInterpretPrompt(message, session.answers);
    const raw = await this.masonInterpret(
      prompt,
      createUtilityModelUsageAttribution({
        operationId: `mason:${encodeURIComponent(session.sessionId)}:answer-extraction`,
        utilityKind: "mason_answer_extraction",
        lineage: {
          // Mason sessions are global setup records and currently carry no
          // trusted workspace or Chat-session binding. Keep that scope absent
          // instead of deriving it from request metadata.
          sessionId: session.sessionId,
          agentId: "mason",
        },
      }),
    );
    const patch = parseMasonInterpretResponse(raw);
    const updated = (await this.citadels.updateMasonSessionAnswers(sessionId, patch)) ?? session;
    return { ok: true, session: updated };
  }

  public reviewBlueprint(value: unknown): MasonReviewResult {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, review: generateBlueprintReviewSummary(value as CitadelBlueprint) };
  }

  /**
   * The Mason's stage step (§9.4): validate the drafted Blueprint, stage the Citadel
   * (Charter + Chambers), and return it alongside a review summary. Staging never
   * connects accounts or opens Gates — the human does that afterwards.
   */
  public async stageBlueprint(citadelId: string, value: unknown, expectedRevision: string): Promise<MasonStageResult> {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const blueprint = value as CitadelBlueprint;
    const review = generateBlueprintReviewSummary(blueprint);
    const citadel = await this.citadels.mutateStructure(createCitadelBlueprintMutation(citadelId, expectedRevision, blueprint));
    return { ok: true, citadel, review };
  }

  /**
   * The Gatehouse decision point: evaluate an action against this Citadel's Wards
   * (deny-wins). This is what a policy enforcement layer calls before allowing an
   * action — the persisted Wards become an actual allow/deny/require_approval decision.
   */
  public async evaluateGatehouseAction(citadelId: string, action: string): Promise<WardEffect> {
    return evaluateWards(await this.citadels.listWards(citadelId), action);
  }

  // --- Gatehouse integration grants (§15.3): capabilities only, no secrets. ---

  public async listIntegrations(citadelId: string): Promise<CitadelIntegrationGrant[]> {
    return await this.citadels.listIntegrationGrants(citadelId);
  }

  public async addIntegration(input: CitadelIntegrationGrantInput & { expectedRevision: string }): Promise<CitadelAccessSnapshot> {
    const { citadelId, expectedRevision, ...integration } = input;
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "add_integration", integration } });
  }

  public async removeIntegration(citadelId: string, grantId: string, expectedRevision: string): Promise<CitadelAccessSnapshot> {
    return await this.citadels.mutateAccess({ citadelId, expectedRevision, change: { type: "remove_integration", grantId } });
  }
}

function snapshotTemplate(template: CitadelTemplate): CitadelTemplateSnapshot {
  // Review and apply the same effective settings, including otherwise implicit defaults.
  const resolved: CitadelTemplate = { ...template, riskPosture: template.riskPosture ?? "balanced",
    modelPolicyDefault: template.modelPolicyDefault ?? "hybrid_guarded",
    chambers: template.chambers.map((chamber) => ({ ...chamber, sensitivity: chamber.sensitivity ?? "private", sealed: chamber.sealed ?? false })),
  };
  const revision = createHash("sha256").update(JSON.stringify({ schemaVersion: "citadel.template.v1", template: resolved })).digest("hex");
  return { ...resolved, revision };
}
