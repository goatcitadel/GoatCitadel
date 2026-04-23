import type { GatewayService } from "./gateway-service.js";

type AuthAdminRouteGateway = Pick<
  GatewayService,
  | "createBackup"
  | "createDeviceAccessRequest"
  | "exchangeCompanionSessionFromDeviceGrant"
  | "getAuthCredentialPlan"
  | "getCompanionSessionInfo"
  | "getCompanionSessionRecord"
  | "getDeviceAccessRequestStatus"
  | "getRetentionPolicy"
  | "listBackups"
  | "listCompanionAuditEvents"
  | "listCompanionSessions"
  | "listDeviceAccessGrants"
  | "pruneRetention"
  | "resolveGatewayInstallToken"
  | "revokeCompanionSession"
  | "revokeDeviceAccessGrant"
  | "rotateCompanionSession"
  | "runDatabaseCutover"
  | "updateRetentionPolicy"
  | "verifyBackup"
  | "verifyDatabaseCutover"
>;

export class AuthAdminRouteService {
  public constructor(private readonly gateway: AuthAdminRouteGateway) {}

  public getAuthCredentialPlan() {
    return this.gateway.getAuthCredentialPlan();
  }

  public createDeviceAccessRequest(
    input: Parameters<AuthAdminRouteGateway["createDeviceAccessRequest"]>[0],
    metadata: Parameters<AuthAdminRouteGateway["createDeviceAccessRequest"]>[1],
  ) {
    return this.gateway.createDeviceAccessRequest(input, metadata);
  }

  public rotateCompanionSession(input: Parameters<AuthAdminRouteGateway["rotateCompanionSession"]>[0]) {
    return this.gateway.rotateCompanionSession(input);
  }

  public exchangeCompanionSessionFromDeviceGrant(
    grantId: string,
    input: Parameters<AuthAdminRouteGateway["exchangeCompanionSessionFromDeviceGrant"]>[1],
  ) {
    return this.gateway.exchangeCompanionSessionFromDeviceGrant(grantId, input);
  }

  public getCompanionSessionInfo(sessionId: string) {
    return this.gateway.getCompanionSessionInfo(sessionId);
  }

  public listCompanionSessions(input: Parameters<AuthAdminRouteGateway["listCompanionSessions"]>[0]) {
    return this.gateway.listCompanionSessions(input);
  }

  public getCompanionSessionRecord(sessionId: string) {
    return this.gateway.getCompanionSessionRecord(sessionId);
  }

  public revokeCompanionSession(sessionId: string, actorId?: string) {
    return this.gateway.revokeCompanionSession(sessionId, actorId?.trim() || "operator");
  }

  public listCompanionAuditEvents(input: Parameters<AuthAdminRouteGateway["listCompanionAuditEvents"]>[0]) {
    return this.gateway.listCompanionAuditEvents(input);
  }

  public listDeviceAccessGrants() {
    return this.gateway.listDeviceAccessGrants();
  }

  public revokeDeviceAccessGrant(grantId: string, actorId?: string) {
    return this.gateway.revokeDeviceAccessGrant(grantId, actorId?.trim() || "operator");
  }

  public resolveGatewayInstallToken(input: Parameters<AuthAdminRouteGateway["resolveGatewayInstallToken"]>[0]) {
    return this.gateway.resolveGatewayInstallToken(input);
  }

  public getDeviceAccessRequestStatus(requestId: string, secret: string) {
    return this.gateway.getDeviceAccessRequestStatus(requestId, secret);
  }

  public getRetentionPolicy() {
    return this.gateway.getRetentionPolicy();
  }

  public updateRetentionPolicy(patch: Parameters<AuthAdminRouteGateway["updateRetentionPolicy"]>[0]) {
    return this.gateway.updateRetentionPolicy(patch);
  }

  public pruneRetention(input: Parameters<AuthAdminRouteGateway["pruneRetention"]>[0]) {
    return this.gateway.pruneRetention(input);
  }

  public listBackups(limit: number) {
    return this.gateway.listBackups(limit);
  }

  public createBackup(input: Parameters<AuthAdminRouteGateway["createBackup"]>[0]) {
    return this.gateway.createBackup(input);
  }

  public verifyBackup(input: Parameters<AuthAdminRouteGateway["verifyBackup"]>[0]) {
    return this.gateway.verifyBackup(input);
  }

  public runDatabaseCutover(input: Parameters<AuthAdminRouteGateway["runDatabaseCutover"]>[0]) {
    return this.gateway.runDatabaseCutover(input);
  }

  public verifyDatabaseCutover(input: Parameters<AuthAdminRouteGateway["verifyDatabaseCutover"]>[0]) {
    return this.gateway.verifyDatabaseCutover(input);
  }
}
