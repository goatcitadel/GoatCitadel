import type {
  BlueprintReviewSummary,
  Citadel,
  CitadelBlueprint,
  CitadelBlueprintValidationResult,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelCouncilAssignment,
  CitadelCouncilAssignmentInput,
  CitadelGatehouseSummary,
  CitadelIntegrationGrant,
  CitadelIntegrationGrantInput,
  CitadelMember,
  CitadelMemberInput,
  MasonAnswers,
  MasonSession,
  CitadelPassage,
  CitadelPassageInput,
  CitadelTemplate,
  CitadelVaultSecretInput,
  CitadelVaultSecretMetadata,
  CitadelVaultSecretRecord,
  CitadelWardInput,
  CitadelWardRecord,
  WardEffect,
} from "@goatcitadel/contracts";
import {
  applyCitadelBlueprint,
  applyCitadelTemplate,
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

/** Interprets a freeform message into raw model output (the Mason's one LLM dependency). */
export type MasonInterpret = (prompt: string) => Promise<string>;

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
  getCitadel(citadelId: string): Citadel | undefined;
  upsertCharter(input: CitadelCharterInput): CitadelCharter;
  createChamber(input: CitadelChamberInput): CitadelChamber;
  listChambers(citadelId: string): CitadelChamber[];
  assignAgent(input: CitadelCouncilAssignmentInput): CitadelCouncilAssignment;
  listCouncilAssignments(citadelId: string): CitadelCouncilAssignment[];
  unassignAgent(citadelId: string, agentId: string): boolean;
  addWard(input: CitadelWardInput): CitadelWardRecord;
  listWards(citadelId: string): CitadelWardRecord[];
  removeWard(citadelId: string, wardId: string): boolean;
  createPassage(input: CitadelPassageInput): CitadelPassage;
  listPassages(sourceCitadelId: string): CitadelPassage[];
  removePassage(sourceCitadelId: string, passageId: string): boolean;
  upsertMember(input: CitadelMemberInput): CitadelMember;
  listMembers(citadelId: string): CitadelMember[];
  removeMember(citadelId: string, subjectId: string): boolean;
  createMasonSession(): MasonSession;
  getMasonSession(sessionId: string): MasonSession | undefined;
  updateMasonSessionAnswers(sessionId: string, patch: Partial<MasonAnswers>): MasonSession | undefined;
  setMasonSessionStatus(sessionId: string, status: MasonSession["status"]): MasonSession | undefined;
  addIntegrationGrant(input: CitadelIntegrationGrantInput): CitadelIntegrationGrant;
  listIntegrationGrants(citadelId: string): CitadelIntegrationGrant[];
  removeIntegrationGrant(citadelId: string, grantId: string): boolean;
  storeVaultSecret(input: CitadelVaultSecretInput): CitadelVaultSecretRecord;
  getVaultSecret(citadelId: string, secretId: string): CitadelVaultSecretRecord | undefined;
  listVaultSecrets(citadelId: string): CitadelVaultSecretRecord[];
  deleteVaultSecret(citadelId: string, secretId: string): boolean;
}

export class CitadelsRouteService {
  public constructor(
    private readonly citadels: CitadelsRoutePort,
    private readonly masonInterpret?: MasonInterpret,
    private readonly vaultKey?: VaultKeyProvider,
  ) {}

  public getCitadel(citadelId: string): Citadel | undefined {
    return this.citadels.getCitadel(citadelId);
  }

  public upsertCharter(input: CitadelCharterInput): CitadelCharter {
    return this.citadels.upsertCharter(input);
  }

  public createChamber(input: CitadelChamberInput): CitadelChamber {
    return this.citadels.createChamber(input);
  }

  public listChambers(citadelId: string): CitadelChamber[] {
    return this.citadels.listChambers(citadelId);
  }

  public listTemplates(): CitadelTemplate[] {
    return CITADEL_TEMPLATES;
  }

  public createFromTemplate(citadelId: string, templateId: string): Citadel | undefined {
    const template = findCitadelTemplate(templateId);
    if (!template) {
      return undefined;
    }
    return applyCitadelTemplate(this.citadels, citadelId, template);
  }

  public exportBlueprint(citadelId: string): CitadelBlueprint | undefined {
    const citadel = this.citadels.getCitadel(citadelId);
    if (!citadel) {
      return undefined;
    }
    return exportCitadelBlueprint(citadel);
  }

  public validateBlueprint(value: unknown): CitadelBlueprintValidationResult {
    return validateCitadelBlueprint(value);
  }

  public createFromBlueprint(citadelId: string, value: unknown): CitadelImportResult {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, citadel: applyCitadelBlueprint(this.citadels, citadelId, value as CitadelBlueprint) };
  }

  public getGatehouse(citadelId: string): (CitadelGatehouseSummary & { wardCount: number }) | undefined {
    const citadel = this.citadels.getCitadel(citadelId);
    if (!citadel) {
      return undefined;
    }
    return { ...summarizeCitadelGatehouse(citadel), wardCount: this.citadels.listWards(citadelId).length };
  }

  public listWards(citadelId: string): CitadelWardRecord[] {
    return this.citadels.listWards(citadelId);
  }

  public addWard(input: CitadelWardInput): CitadelWardRecord {
    return this.citadels.addWard(input);
  }

  public removeWard(citadelId: string, wardId: string): boolean {
    return this.citadels.removeWard(citadelId, wardId);
  }

  /** Vault secret names + provenance — never the sealed or opened value. */
  public listVaultSecrets(citadelId: string): CitadelVaultSecretMetadata[] {
    return this.citadels.listVaultSecrets(citadelId).map(toVaultSecretMetadata);
  }

  /** Seal a plaintext under the Citadel's master key and persist it. Fails closed if no key. */
  public storeVaultSecret(citadelId: string, secretName: string, plaintext: string): VaultStoreResult {
    const key = this.vaultKey?.(citadelId);
    if (!key) {
      return { ok: false, reason: "unavailable" };
    }
    const record = this.citadels.storeVaultSecret({ citadelId, secretName, sealedValue: sealValue(plaintext, key) });
    return { ok: true, secret: toVaultSecretMetadata(record) };
  }

  /** Open a stored secret with the Citadel's master key. Fails closed if no key or undecryptable. */
  public revealVaultSecret(citadelId: string, secretId: string): VaultRevealResult {
    const key = this.vaultKey?.(citadelId);
    if (!key) {
      return { ok: false, reason: "unavailable" };
    }
    const record = this.citadels.getVaultSecret(citadelId, secretId);
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

  public deleteVaultSecret(citadelId: string, secretId: string): boolean {
    return this.citadels.deleteVaultSecret(citadelId, secretId);
  }

  /** The Council is the set of existing agents assigned to this Citadel (by id). */
  public listCouncil(citadelId: string): CitadelCouncilAssignment[] {
    return this.citadels.listCouncilAssignments(citadelId);
  }

  public assignAgent(input: CitadelCouncilAssignmentInput): CitadelCouncilAssignment {
    return this.citadels.assignAgent(input);
  }

  public unassignAgent(citadelId: string, agentId: string): boolean {
    return this.citadels.unassignAgent(citadelId, agentId);
  }

  public listPassages(sourceCitadelId: string): CitadelPassage[] {
    return this.citadels.listPassages(sourceCitadelId);
  }

  public createPassage(input: CitadelPassageInput): CitadelPassage {
    return this.citadels.createPassage(input);
  }

  public removePassage(sourceCitadelId: string, passageId: string): boolean {
    return this.citadels.removePassage(sourceCitadelId, passageId);
  }

  public listMembers(citadelId: string): CitadelMember[] {
    return this.citadels.listMembers(citadelId);
  }

  public upsertMember(input: CitadelMemberInput): CitadelMember {
    return this.citadels.upsertMember(input);
  }

  public removeMember(citadelId: string, subjectId: string): boolean {
    return this.citadels.removeMember(citadelId, subjectId);
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

  public createMasonSession(): MasonSession {
    return this.citadels.createMasonSession();
  }

  public getMasonSession(sessionId: string): MasonSession | undefined {
    return this.citadels.getMasonSession(sessionId);
  }

  public updateMasonSessionAnswers(sessionId: string, patch: Partial<MasonAnswers>): MasonSession | undefined {
    return this.citadels.updateMasonSessionAnswers(sessionId, patch);
  }

  public draftFromSession(sessionId: string): MasonDraftResult {
    const session = this.citadels.getMasonSession(sessionId);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }
    if (!masonSessionCanDraft(session)) {
      return { ok: false, reason: "incomplete" };
    }
    const blueprint = draftBlueprintFromAnswers(session.answers as MasonAnswers);
    this.citadels.setMasonSessionStatus(sessionId, "drafted");
    return { ok: true, blueprint };
  }

  /**
   * Process a freeform message in a Mason session: build the extraction prompt, call
   * the model (if configured), strictly parse the result, and merge it into the
   * session's accumulated answers. Degrades gracefully when no model is configured.
   */
  public async interpretSessionMessage(sessionId: string, message: string): Promise<MasonMessageResult> {
    const session = this.citadels.getMasonSession(sessionId);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }
    if (!this.masonInterpret) {
      return { ok: false, reason: "no_interpreter" };
    }
    const prompt = buildMasonInterpretPrompt(message, session.answers);
    const raw = await this.masonInterpret(prompt);
    const patch = parseMasonInterpretResponse(raw);
    const updated = this.citadels.updateMasonSessionAnswers(sessionId, patch) ?? session;
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
  public stageBlueprint(citadelId: string, value: unknown): MasonStageResult {
    const validation = validateCitadelBlueprint(value);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const blueprint = value as CitadelBlueprint;
    const citadel = applyCitadelBlueprint(this.citadels, citadelId, blueprint);
    return { ok: true, citadel, review: generateBlueprintReviewSummary(blueprint) };
  }

  /**
   * The Gatehouse decision point: evaluate an action against this Citadel's Wards
   * (deny-wins). This is what a policy enforcement layer calls before allowing an
   * action — the persisted Wards become an actual allow/deny/require_approval decision.
   */
  public evaluateGatehouseAction(citadelId: string, action: string): WardEffect {
    return evaluateWards(this.citadels.listWards(citadelId), action);
  }

  // --- Gatehouse integration grants (§15.3): capabilities only, no secrets. ---

  public listIntegrations(citadelId: string): CitadelIntegrationGrant[] {
    return this.citadels.listIntegrationGrants(citadelId);
  }

  public addIntegration(input: CitadelIntegrationGrantInput): CitadelIntegrationGrant {
    return this.citadels.addIntegrationGrant(input);
  }

  public removeIntegration(citadelId: string, grantId: string): boolean {
    return this.citadels.removeIntegrationGrant(citadelId, grantId);
  }
}
