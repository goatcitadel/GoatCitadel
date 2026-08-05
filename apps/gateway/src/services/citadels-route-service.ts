import type {
  BlueprintReviewSummary,
  Citadel,
  CitadelBlueprint,
  CitadelBlueprintValidationResult,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
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
  CitadelTemplate,
  CitadelUpdateInput,
  CitadelVaultSecretInput,
  CitadelVaultSecretMetadata,
  CitadelVaultSecretRecord,
  CitadelWardInput,
  CitadelWardRecord,
  WardEffect,
} from "@goatcitadel/contracts";
import {
  buildMasonInterpretPrompt,
  CITADEL_TEMPLATES,
  draftBlueprintFromAnswers,
  evaluateWards,
  masonSessionCanDraft,
  exportCitadelBlueprint,
  findCitadelTemplate,
  generateBlueprintReviewSummary,
  MASON_SETUP_QUESTIONS,
  parseMasonInterpretResponse,
  summarizeCitadelGatehouse,
  toVaultSecretMetadata,
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

export type VaultStoreResult = { ok: false; reason: "unavailable" } | { ok: true; secret: CitadelVaultSecretMetadata };

export type VaultRevealResult = { ok: false; reason: "unavailable" | "not_found" } | { ok: true; value: string };

export type CitadelImportResult = { ok: false; errors: string[] } | { ok: true; citadel: Citadel };

export type MasonReviewResult = { ok: false; errors: string[] } | { ok: true; review: BlueprintReviewSummary };

export type MasonStageResult =
  | { ok: false; errors: string[] }
  | { ok: true; citadel: Citadel; review: BlueprintReviewSummary };

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
  archiveRecord(citadelId: string): Promise<CitadelRecord>;
  restoreRecord(citadelId: string): Promise<CitadelRecord>;
  getCitadel(citadelId: string): Promise<Citadel | undefined>;
  upsertCharter(input: CitadelCharterInput): Promise<CitadelCharter>;
  createChamber(input: CitadelChamberInput): Promise<CitadelChamber>;
  listChambers(citadelId: string): Promise<CitadelChamber[]>;
  assignAgent(input: CitadelCouncilAssignmentInput): Promise<CitadelCouncilAssignment>;
  listCouncilAssignments(citadelId: string): Promise<CitadelCouncilAssignment[]>;
  unassignAgent(citadelId: string, agentId: string): Promise<boolean>;
  addWard(input: CitadelWardInput): Promise<CitadelWardRecord>;
  listWards(citadelId: string): Promise<CitadelWardRecord[]>;
  removeWard(citadelId: string, wardId: string): Promise<boolean>;
  createPassage(input: CitadelPassageInput): Promise<CitadelPassage>;
  listPassages(sourceCitadelId: string): Promise<CitadelPassage[]>;
  removePassage(sourceCitadelId: string, passageId: string): Promise<boolean>;
  upsertMember(input: CitadelMemberInput): Promise<CitadelMember>;
  listMembers(citadelId: string): Promise<CitadelMember[]>;
  removeMember(citadelId: string, subjectId: string): Promise<boolean>;
  createMasonSession(): Promise<MasonSession>;
  getMasonSession(sessionId: string): Promise<MasonSession | undefined>;
  updateMasonSessionAnswers(sessionId: string, patch: Partial<MasonAnswers>): Promise<MasonSession | undefined>;
  setMasonSessionStatus(sessionId: string, status: MasonSession["status"]): Promise<MasonSession | undefined>;
  addIntegrationGrant(input: CitadelIntegrationGrantInput): Promise<CitadelIntegrationGrant>;
  listIntegrationGrants(citadelId: string): Promise<CitadelIntegrationGrant[]>;
  removeIntegrationGrant(citadelId: string, grantId: string): Promise<boolean>;
  storeVaultSecret(input: CitadelVaultSecretInput): Promise<CitadelVaultSecretRecord>;
  getVaultSecret(citadelId: string, secretId: string): Promise<CitadelVaultSecretRecord | undefined>;
  listVaultSecrets(citadelId: string): Promise<CitadelVaultSecretRecord[]>;
  deleteVaultSecret(citadelId: string, secretId: string): Promise<boolean>;
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

  public async archiveRecord(citadelId: string): Promise<CitadelRecord> {
    return await this.citadels.archiveRecord(citadelId);
  }

  public async restoreRecord(citadelId: string): Promise<CitadelRecord> {
    return await this.citadels.restoreRecord(citadelId);
  }

  public async getCitadel(citadelId: string): Promise<Citadel | undefined> {
    return await this.citadels.getCitadel(citadelId);
  }

  public async upsertCharter(input: CitadelCharterInput): Promise<CitadelCharter> {
    return await this.citadels.upsertCharter(input);
  }

  public async createChamber(input: CitadelChamberInput): Promise<CitadelChamber> {
    return await this.citadels.createChamber(input);
  }

  public async listChambers(citadelId: string): Promise<CitadelChamber[]> {
    return await this.citadels.listChambers(citadelId);
  }

  public listTemplates(): CitadelTemplate[] {
    return CITADEL_TEMPLATES;
  }

  public async createFromTemplate(citadelId: string, templateId: string): Promise<Citadel | undefined> {
    const template = findCitadelTemplate(templateId);
    if (!template) {
      return undefined;
    }
    return await applyCitadelTemplateAsync(this.citadels, citadelId, template);
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

  public async createFromBlueprint(citadelId: string, value: unknown): Promise<CitadelImportResult> {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, citadel: await applyCitadelBlueprintAsync(this.citadels, citadelId, value as CitadelBlueprint) };
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

  public async addWard(input: CitadelWardInput): Promise<CitadelWardRecord> {
    return await this.citadels.addWard(input);
  }

  public async removeWard(citadelId: string, wardId: string): Promise<boolean> {
    return await this.citadels.removeWard(citadelId, wardId);
  }

  /** Vault secret names + provenance — never the sealed or opened value. */
  public async listVaultSecrets(citadelId: string): Promise<CitadelVaultSecretMetadata[]> {
    return (await this.citadels.listVaultSecrets(citadelId)).map(toVaultSecretMetadata);
  }

  /** Seal a plaintext under the Citadel's master key and persist it. Fails closed if no key. */
  public async storeVaultSecret(citadelId: string, secretName: string, plaintext: string): Promise<VaultStoreResult> {
    const key = this.vaultKey?.(citadelId);
    if (!key) {
      return { ok: false, reason: "unavailable" };
    }
    const record = await this.citadels.storeVaultSecret({
      citadelId,
      secretName,
      sealedValue: sealValue(plaintext, key),
    });
    return { ok: true, secret: toVaultSecretMetadata(record) };
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

  public async deleteVaultSecret(citadelId: string, secretId: string): Promise<boolean> {
    return await this.citadels.deleteVaultSecret(citadelId, secretId);
  }

  /** The Council is the set of existing agents assigned to this Citadel (by id). */
  public async listCouncil(citadelId: string): Promise<CitadelCouncilAssignment[]> {
    return await this.citadels.listCouncilAssignments(citadelId);
  }

  public async assignAgent(input: CitadelCouncilAssignmentInput): Promise<CitadelCouncilAssignment> {
    return await this.citadels.assignAgent(input);
  }

  public async unassignAgent(citadelId: string, agentId: string): Promise<boolean> {
    return await this.citadels.unassignAgent(citadelId, agentId);
  }

  public async listPassages(sourceCitadelId: string): Promise<CitadelPassage[]> {
    return await this.citadels.listPassages(sourceCitadelId);
  }

  public async createPassage(input: CitadelPassageInput): Promise<CitadelPassage> {
    return await this.citadels.createPassage(input);
  }

  public async removePassage(sourceCitadelId: string, passageId: string): Promise<boolean> {
    return await this.citadels.removePassage(sourceCitadelId, passageId);
  }

  public async listMembers(citadelId: string): Promise<CitadelMember[]> {
    return await this.citadels.listMembers(citadelId);
  }

  public async upsertMember(input: CitadelMemberInput): Promise<CitadelMember> {
    return await this.citadels.upsertMember(input);
  }

  public async removeMember(citadelId: string, subjectId: string): Promise<boolean> {
    return await this.citadels.removeMember(citadelId, subjectId);
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
  public async stageBlueprint(citadelId: string, value: unknown): Promise<MasonStageResult> {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const blueprint = value as CitadelBlueprint;
    const citadel = await applyCitadelBlueprintAsync(this.citadels, citadelId, blueprint);
    return { ok: true, citadel, review: generateBlueprintReviewSummary(blueprint) };
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

  public async addIntegration(input: CitadelIntegrationGrantInput): Promise<CitadelIntegrationGrant> {
    return await this.citadels.addIntegrationGrant(input);
  }

  public async removeIntegration(citadelId: string, grantId: string): Promise<boolean> {
    return await this.citadels.removeIntegrationGrant(citadelId, grantId);
  }
}

async function applyCitadelTemplateAsync(
  target: CitadelsRoutePort,
  citadelId: string,
  template: CitadelTemplate,
): Promise<Citadel> {
  await target.upsertCharter({
    citadelId,
    purpose: template.purpose,
    kind: template.kind,
    goals: template.goals,
    boundaries: template.boundaries,
    successDefinition: template.successDefinition,
    riskPosture: template.riskPosture,
    modelPolicyDefault: template.modelPolicyDefault,
  });
  for (const chamber of template.chambers) {
    await target.createChamber({
      citadelId,
      name: chamber.name,
      sensitivity: chamber.sensitivity,
      sealed: chamber.sealed,
    });
  }
  const citadel = await target.getCitadel(citadelId);
  if (!citadel) {
    throw new Error(`Failed to instantiate citadel ${citadelId} from template ${template.id}`);
  }
  return citadel;
}

async function applyCitadelBlueprintAsync(
  target: CitadelsRoutePort,
  citadelId: string,
  blueprint: CitadelBlueprint,
): Promise<Citadel> {
  await target.upsertCharter({
    citadelId,
    purpose: blueprint.charter.purpose,
    kind: blueprint.charter.kind,
    goals: blueprint.charter.goals,
    boundaries: blueprint.charter.boundaries,
    successDefinition: blueprint.charter.successDefinition,
    riskPosture: blueprint.charter.riskPosture,
    modelPolicyDefault: blueprint.charter.modelPolicyDefault,
  });
  for (const chamber of blueprint.chambers) {
    await target.createChamber({
      citadelId,
      name: chamber.name,
      sensitivity: chamber.sensitivity,
      sealed: chamber.sealed,
    });
  }
  const citadel = await target.getCitadel(citadelId);
  if (!citadel) {
    throw new Error(`Failed to import Blueprint into citadel ${citadelId}`);
  }
  return citadel;
}
