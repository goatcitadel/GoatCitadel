import type {
  BankrActionAuditRecord,
  BankrActionPreviewRequest,
  BankrActionPreviewResponse,
  BankrSafetyPolicy,
  SkillActivationDecision,
  SkillActivationPolicy,
  SkillImportHistoryRecord,
  SkillImportValidationResult,
  SkillListItem,
  SkillResolveInput,
  SkillRuntimeState,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillSourceProvider,
  SkillStateRecord,
} from "@goatcitadel/contracts";

export interface SkillImportInstallResult {
  validation: SkillImportValidationResult;
  installedPath: string;
  sourceManifestPath: string;
  installedSkillId?: string;
}

export interface SkillsRoutePort {
  bulkSetSkillState(skillIds: string[], state: SkillRuntimeState, note?: string): SkillStateRecord[];
  getBankrOptionalMigrationMessage(): string;
  getBankrSafetyPolicy(): BankrSafetyPolicy;
  getSkillActivationPolicy(): SkillActivationPolicy;
  installSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
    force?: boolean;
    confirmHighRisk?: boolean;
  }): Promise<SkillImportInstallResult>;
  isBankrBuiltinEnabled(): boolean;
  listBankrActionAudit(limit?: number, cursor?: string): BankrActionAuditRecord[];
  listSkillImportHistory(limit?: number): SkillImportHistoryRecord[];
  listSkillSources(query?: string, limit?: number): Promise<SkillSourceListResponse>;
  listSkills(): SkillListItem[];
  lookupSkillSources(queryOrUrl: string, limit?: number): Promise<SkillSourceLookupResponse>;
  previewBankrAction(input: BankrActionPreviewRequest): BankrActionPreviewResponse;
  reloadSkills(): Promise<SkillListItem[]>;
  resolveSkillActivation(input: SkillResolveInput): SkillActivationDecision;
  setSkillState(skillId: string, state: SkillRuntimeState, note?: string): SkillStateRecord;
  updateBankrSafetyPolicy(input: Partial<BankrSafetyPolicy>): BankrSafetyPolicy;
  updateSkillActivationPolicy(input: Partial<SkillActivationPolicy>): SkillActivationPolicy;
  validateSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
  }): Promise<SkillImportValidationResult>;
}

export class SkillsRouteService {
  public constructor(private readonly skills: SkillsRoutePort) {}

  public getBankrOptionalMigrationMessage() {
    return this.skills.getBankrOptionalMigrationMessage();
  }

  public isBankrBuiltinEnabled() {
    return this.skills.isBankrBuiltinEnabled();
  }

  public listSkills() {
    return this.skills.listSkills();
  }

  public reloadSkills() {
    return this.skills.reloadSkills();
  }

  public listSkillSources(query?: string, limit?: number) {
    return this.skills.listSkillSources(query, limit);
  }

  public lookupSkillSources(queryOrUrl: string, limit?: number) {
    return this.skills.lookupSkillSources(queryOrUrl, limit);
  }

  public validateSkillImport(input: Parameters<SkillsRoutePort["validateSkillImport"]>[0]) {
    return this.skills.validateSkillImport(input);
  }

  public installSkillImport(input: Parameters<SkillsRoutePort["installSkillImport"]>[0]) {
    return this.skills.installSkillImport(input);
  }

  public listSkillImportHistory(limit?: number) {
    return this.skills.listSkillImportHistory(limit);
  }

  public resolveSkillActivation(input: SkillResolveInput) {
    return this.skills.resolveSkillActivation(input);
  }

  public setSkillState(skillId: string, state: SkillRuntimeState, note?: string) {
    return this.skills.setSkillState(skillId, state, note);
  }

  public bulkSetSkillState(skillIds: string[], state: SkillRuntimeState, note?: string) {
    return this.skills.bulkSetSkillState(skillIds, state, note);
  }

  public getSkillActivationPolicy() {
    return this.skills.getSkillActivationPolicy();
  }

  public updateSkillActivationPolicy(input: Partial<SkillActivationPolicy>) {
    return this.skills.updateSkillActivationPolicy(input);
  }

  public getBankrSafetyPolicy() {
    return this.skills.getBankrSafetyPolicy();
  }

  public updateBankrSafetyPolicy(input: Partial<BankrSafetyPolicy>) {
    return this.skills.updateBankrSafetyPolicy(input);
  }

  public previewBankrAction(input: BankrActionPreviewRequest) {
    return this.skills.previewBankrAction(input);
  }

  public listBankrActionAudit(limit?: number, cursor?: string) {
    return this.skills.listBankrActionAudit(limit, cursor);
  }
}
