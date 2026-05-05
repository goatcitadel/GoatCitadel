import type { GatewayRuntimeConfig } from "../config.js";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRouteServices } from "./gateway-route-services.js";
import { GatewayService } from "./gateway-service.js";
import type { CapabilityPackService } from "./capability-pack-service.js";
import type { ContinuationGateService } from "./continuation-gate-service.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import type { MemoryWriteGateService } from "./memory-write-gate-service.js";

export interface GatewayRuntimePort {
  readonly storage: Storage;
  readonly routeServices: GatewayRouteServices;
  readonly capabilityPackService: CapabilityPackService;
  readonly continuationGateService: ContinuationGateService;
  readonly evidenceEnvelopeService: EvidenceEnvelopeService;
  readonly memoryWriteGateService: MemoryWriteGateService;
  attachDevDiagnosticsLogger(logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }): void;
  init(): Promise<void>;
  initCritical(): Promise<void>;
  startDeferredInit(): Promise<void>;
  recordDevDiagnostic(input: unknown): void;
  getOnboardingStartupState(): { completed?: boolean };
  close(): Promise<void>;
}

export interface GatewayAuthValidationPort {
  getOnboardingStartupState(): { completed?: boolean };
  validateDeviceAccessToken(token: string): { actorId: string; deviceId: string; grantId: string } | undefined;
  validateCompanionAccessToken(
    token: string,
  ): { actorId: string; deviceId: string; grantId: string; sessionId: string } | undefined;
  verifyCompanionRequestSignature(input: unknown): unknown;
}

export type GatewayRuntimeInstance = GatewayRuntimePort & GatewayAuthValidationPort;

export interface GatewayAdminPort extends GatewayRuntimePort, GatewayAuthValidationPort {
  createBackup(input: { name?: string; outputPath?: string }): Promise<unknown>;
  getAuthCredentialPlan(): unknown;
  getRetentionPolicy(): unknown;
  listBackups(limit?: number): Promise<unknown>;
  pruneRetention(input: { dryRun?: boolean }): Promise<unknown>;
  resolveGatewayInstallToken(input: {
    token?: string;
    generateWhenMissing?: boolean;
    persistToEnv?: boolean;
  }): Promise<unknown>;
  runDatabaseCutover(input: { profile: "local" | "hosted"; execute: boolean; confirm?: boolean }): Promise<unknown>;
  updateRetentionPolicy(input: {
    realtimeEventsDays?: number;
    backupsKeep?: number;
    transcriptsDays?: number;
    auditDays?: number;
  }): unknown;
  verifyDatabaseCutover(input: { source: string; target?: string }): Promise<unknown>;
}

export function createGatewayRuntime(config: GatewayRuntimeConfig): GatewayRuntimeInstance {
  return new GatewayService(config);
}

export function createGatewayAdminRuntime(config: GatewayRuntimeConfig): GatewayAdminPort {
  return new GatewayService(config);
}
