import type {
  BackupCreateResponse,
  BackupManifestRecord,
  CompanionSessionExchangeInput,
  CompanionSessionRefreshInput,
  DatabaseCutoverRequest,
  DatabaseCutoverResponse,
  DeviceAccessGrantRecord as DeviceAccessGrantContractRecord,
  DeviceAccessRequestCreateInput,
  RetentionPolicy,
  RetentionPruneResult,
} from "@goatcitadel/contracts";

export interface DeviceAccessRequestMetadata {
  requestedOrigin?: string;
  requestedIp?: string;
  userAgent?: string;
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
}

export interface CompanionSessionListOptions {
  view?: "active" | "all";
  grantId?: string;
  limit?: number;
}

export interface CompanionAuditListOptions {
  sessionId?: string;
  grantId?: string;
  limit?: number;
}

export interface AuthAdminRoutePort {
  createBackup(input?: { name?: string; outputPath?: string }): Promise<BackupCreateResponse>;
  createDeviceAccessRequest(input: DeviceAccessRequestCreateInput, metadata: DeviceAccessRequestMetadata): unknown;
  exchangeCompanionSessionFromDeviceGrant(grantId: string, input: CompanionSessionExchangeInput): unknown;
  getAuthCredentialPlan(): unknown;
  getCompanionSessionInfo(sessionId: string): unknown;
  getCompanionSessionRecord(sessionId: string): unknown;
  getDeviceAccessRequestStatus(requestId: string, secret: string): unknown;
  getRetentionPolicy(): RetentionPolicy;
  listBackups(limit: number): Promise<BackupManifestRecord[]>;
  listCompanionAuditEvents(input?: CompanionAuditListOptions): unknown;
  listCompanionSessions(input?: CompanionSessionListOptions): unknown;
  listDeviceAccessGrants(): DeviceAccessGrantContractRecord[];
  pruneRetention(input: { dryRun?: boolean }): Promise<RetentionPruneResult>;
  resolveGatewayInstallToken(input: unknown): unknown;
  revokeCompanionSession(sessionId: string, actorId: string): unknown;
  revokeDeviceAccessGrant(grantId: string, actorId: string): Promise<DeviceAccessGrantContractRecord>;
  rotateCompanionSession(input: CompanionSessionRefreshInput): unknown;
  runDatabaseCutover(input: DatabaseCutoverRequest): Promise<DatabaseCutoverResponse>;
  updateRetentionPolicy(patch: Partial<RetentionPolicy>): RetentionPolicy;
  verifyBackup(input: unknown): unknown;
  verifyDatabaseCutover(input: unknown): unknown;
}

export class AuthAdminRouteService {
  public constructor(private readonly gateway: AuthAdminRoutePort) {}

  public getAuthCredentialPlan() {
    return this.gateway.getAuthCredentialPlan();
  }

  public createDeviceAccessRequest(input: DeviceAccessRequestCreateInput, metadata: DeviceAccessRequestMetadata) {
    return this.gateway.createDeviceAccessRequest(input, metadata);
  }

  public rotateCompanionSession(input: CompanionSessionRefreshInput) {
    return this.gateway.rotateCompanionSession(input);
  }

  public exchangeCompanionSessionFromDeviceGrant(grantId: string, input: CompanionSessionExchangeInput) {
    return this.gateway.exchangeCompanionSessionFromDeviceGrant(grantId, input);
  }

  public getCompanionSessionInfo(sessionId: string) {
    return this.gateway.getCompanionSessionInfo(sessionId);
  }

  public listCompanionSessions(input?: CompanionSessionListOptions) {
    return this.gateway.listCompanionSessions(input);
  }

  public getCompanionSessionRecord(sessionId: string) {
    return this.gateway.getCompanionSessionRecord(sessionId);
  }

  public revokeCompanionSession(sessionId: string, actorId?: string) {
    return this.gateway.revokeCompanionSession(sessionId, actorId?.trim() || "operator");
  }

  public listCompanionAuditEvents(input?: CompanionAuditListOptions) {
    return this.gateway.listCompanionAuditEvents(input);
  }

  public listDeviceAccessGrants() {
    return this.gateway.listDeviceAccessGrants();
  }

  public revokeDeviceAccessGrant(grantId: string, actorId?: string) {
    return this.gateway.revokeDeviceAccessGrant(grantId, actorId?.trim() || "operator");
  }

  public resolveGatewayInstallToken(input: unknown) {
    return this.gateway.resolveGatewayInstallToken(input);
  }

  public getDeviceAccessRequestStatus(requestId: string, secret: string) {
    return this.gateway.getDeviceAccessRequestStatus(requestId, secret);
  }

  public getRetentionPolicy() {
    return this.gateway.getRetentionPolicy();
  }

  public updateRetentionPolicy(patch: Partial<RetentionPolicy>) {
    return this.gateway.updateRetentionPolicy(patch);
  }

  public pruneRetention(input: { dryRun?: boolean }) {
    return this.gateway.pruneRetention(input);
  }

  public listBackups(limit: number) {
    return this.gateway.listBackups(limit);
  }

  public createBackup(input?: { name?: string; outputPath?: string }) {
    return this.gateway.createBackup(input);
  }

  public verifyBackup(input: unknown) {
    return this.gateway.verifyBackup(input);
  }

  public runDatabaseCutover(input: DatabaseCutoverRequest) {
    return this.gateway.runDatabaseCutover(input);
  }

  public verifyDatabaseCutover(input: unknown) {
    return this.gateway.verifyDatabaseCutover(input);
  }
}
