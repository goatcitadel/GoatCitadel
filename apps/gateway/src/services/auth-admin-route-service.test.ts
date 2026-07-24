import { describe, expect, it, vi } from "vitest";
import { AuthAdminRouteService } from "./auth-admin-route-service.js";

function createGateway() {
  const call = (method: string) => vi.fn((...args: unknown[]) => ({ method, args }));
  return {
    createBackup: call("createBackup"),
    createDeviceAccessRequest: call("createDeviceAccessRequest"),
    exchangeCompanionSessionFromDeviceGrant: call("exchangeCompanionSessionFromDeviceGrant"),
    getAuthCredentialPlan: call("getAuthCredentialPlan"),
    getCompanionSessionInfo: call("getCompanionSessionInfo"),
    getCompanionSessionRecord: call("getCompanionSessionRecord"),
    getDeviceAccessRequestStatus: call("getDeviceAccessRequestStatus"),
    getRetentionPolicy: call("getRetentionPolicy"),
    listBackups: call("listBackups"),
    listCompanionAuditEvents: call("listCompanionAuditEvents"),
    listCompanionSessions: call("listCompanionSessions"),
    listDeviceAccessGrants: call("listDeviceAccessGrants"),
    pruneRetention: call("pruneRetention"),
    resolveGatewayInstallToken: call("resolveGatewayInstallToken"),
    revokeCompanionSession: call("revokeCompanionSession"),
    revokeDeviceAccessGrant: call("revokeDeviceAccessGrant"),
    rotateCompanionSession: call("rotateCompanionSession"),
    runDatabaseCutover: call("runDatabaseCutover"),
    updateRetentionPolicy: call("updateRetentionPolicy"),
    verifyBackup: call("verifyBackup"),
    verifyDatabaseCutover: call("verifyDatabaseCutover"),
  };
}

describe("AuthAdminRouteService", () => {
  it("forwards auth, companion, retention, backup, and cutover calls to the gateway port", () => {
    const gateway = createGateway();
    const service = new AuthAdminRouteService(gateway as never);

    expect(service.getAuthCredentialPlan()).toEqual({ method: "getAuthCredentialPlan", args: [] });
    expect(service.createDeviceAccessRequest({ label: "phone" } as never, { requestedIp: "127.0.0.1" })).toEqual({
      method: "createDeviceAccessRequest",
      args: [{ label: "phone" }, { requestedIp: "127.0.0.1" }],
    });
    expect(service.rotateCompanionSession({ sessionId: "session-1" } as never)).toEqual({
      method: "rotateCompanionSession",
      args: [{ sessionId: "session-1" }],
    });
    expect(service.exchangeCompanionSessionFromDeviceGrant("grant-1", { deviceName: "phone" } as never)).toEqual({
      method: "exchangeCompanionSessionFromDeviceGrant",
      args: ["grant-1", { deviceName: "phone" }],
    });
    expect(service.getCompanionSessionInfo("session-1")).toEqual({
      method: "getCompanionSessionInfo",
      args: ["session-1"],
    });
    expect(service.listCompanionSessions({ view: "active", limit: 2 })).toEqual({
      method: "listCompanionSessions",
      args: [{ view: "active", limit: 2 }],
    });
    expect(service.getCompanionSessionRecord("session-1")).toEqual({
      method: "getCompanionSessionRecord",
      args: ["session-1"],
    });
    expect(service.revokeCompanionSession("session-1", " tester ", { correlationId: "corr-1" })).toEqual({
      method: "revokeCompanionSession",
      args: ["session-1", "tester", { correlationId: "corr-1" }],
    });
    expect(service.revokeCompanionSession("session-2", "   ")).toEqual({
      method: "revokeCompanionSession",
      args: ["session-2", "operator", undefined],
    });
    expect(service.listCompanionAuditEvents({ sessionId: "session-1" })).toEqual({
      method: "listCompanionAuditEvents",
      args: [{ sessionId: "session-1" }],
    });
    expect(service.listDeviceAccessGrants()).toEqual({ method: "listDeviceAccessGrants", args: [] });
    expect(service.revokeDeviceAccessGrant("grant-1", " admin ", { correlationId: "corr-2" })).toEqual({
      method: "revokeDeviceAccessGrant",
      args: ["grant-1", "admin", { correlationId: "corr-2" }],
    });
    expect(service.revokeDeviceAccessGrant("grant-2")).toEqual({
      method: "revokeDeviceAccessGrant",
      args: ["grant-2", "operator", undefined],
    });
    expect(service.resolveGatewayInstallToken({ token: "install" })).toEqual({
      method: "resolveGatewayInstallToken",
      args: [{ token: "install" }],
    });
    expect(service.getDeviceAccessRequestStatus("request-1", "secret")).toEqual({
      method: "getDeviceAccessRequestStatus",
      args: ["request-1", "secret"],
    });
    expect(service.getRetentionPolicy()).toEqual({ method: "getRetentionPolicy", args: [] });
    expect(service.updateRetentionPolicy({ keepDays: 3 } as never)).toEqual({
      method: "updateRetentionPolicy",
      args: [{ keepDays: 3 }],
    });
    expect(service.pruneRetention({ dryRun: true })).toEqual({
      method: "pruneRetention",
      args: [{ dryRun: true }],
    });
    expect(service.listBackups(7)).toEqual({ method: "listBackups", args: [7] });
    expect(service.createBackup({ name: "manual" })).toEqual({
      method: "createBackup",
      args: [{ name: "manual" }],
    });
    expect(service.verifyBackup({ filePath: "backup.zip" })).toEqual({
      method: "verifyBackup",
      args: [{ filePath: "backup.zip" }],
    });
    expect(service.runDatabaseCutover({ profile: "local", execute: false })).toEqual({
      method: "runDatabaseCutover",
      args: [{ profile: "local", execute: false }],
    });
    expect(service.verifyDatabaseCutover({ source: "sqlite" })).toEqual({
      method: "verifyDatabaseCutover",
      args: [{ source: "sqlite" }],
    });
  });
});
