import type { LlmRuntimeConfig } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { GatewayRouteServices } from "./gateway-route-services.js";
import { GatewayService } from "./gateway-service.js";
import type { BrowserSessionRuntimeService } from "./browser-session-runtime-service.js";
import type { ReviewReadinessService } from "./review-readiness-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";

type GatewayLogger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export interface GatewayRuntimePort {
  readonly browserSessionRuntimeService: BrowserSessionRuntimeService;
  readonly mutationIdempotencyStore: MutationIdempotencyStore;
  readonly reviewReadinessService: ReviewReadinessService;
  readonly routeServices: GatewayRouteServices;
  attachDevDiagnosticsLogger(logger: GatewayLogger): void;
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
  findCronRunById(
    runId: string,
  ): { runId: string; jobId: string; status: "ok"; finishedAt?: string; output?: string } | undefined;
  getAuthCredentialPlan(): unknown;
  getLlmConfig(): LlmRuntimeConfig;
  getRetentionPolicy(): unknown;
  listBackups(limit?: number): Promise<unknown>;
  pruneRetention(input: { dryRun?: boolean }): Promise<unknown>;
  resolveGatewayInstallToken(input: {
    token?: string;
    generateWhenMissing?: boolean;
    persistToEnv?: boolean;
  }): Promise<unknown>;
  runCronJobNow(jobId: string): Promise<{ jobId: string; runId: string; status: "ok" }>;
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
  return createGatewayRuntimeFacade(new GatewayService(config));
}

export function createGatewayAdminRuntime(config: GatewayRuntimeConfig): GatewayAdminPort {
  const gateway = new GatewayService(config);
  return {
    ...createGatewayRuntimeFacade(gateway),
    createBackup: (input) => gateway.createBackup(input),
    findCronRunById: (runId) => gateway.cronAutomationService.findCronRunById(runId),
    getAuthCredentialPlan: () => gateway.getAuthCredentialPlan(),
    getLlmConfig: () => gateway.getLlmConfig(),
    getRetentionPolicy: () => gateway.getRetentionPolicy(),
    listBackups: (limit) => gateway.listBackups(limit),
    pruneRetention: (input) => gateway.pruneRetention(input),
    resolveGatewayInstallToken: (input) => gateway.resolveGatewayInstallToken(input),
    runCronJobNow: (jobId) => gateway.cronAutomationService.runCronJobNow(jobId),
    runDatabaseCutover: (input) => gateway.runDatabaseCutover(input),
    updateRetentionPolicy: (input) => gateway.updateRetentionPolicy(input),
    verifyDatabaseCutover: (input) => gateway.verifyDatabaseCutover(input),
  };
}

function createGatewayRuntimeFacade(gateway: GatewayService): GatewayRuntimeInstance {
  return {
    get browserSessionRuntimeService() {
      return gateway.browserSessionRuntimeService;
    },
    get mutationIdempotencyStore() {
      return gateway.mutationIdempotencyStore;
    },
    get reviewReadinessService() {
      return gateway.reviewReadinessService;
    },
    get routeServices() {
      return gateway.routeServices;
    },
    attachDevDiagnosticsLogger: (logger) => gateway.attachDevDiagnosticsLogger(logger),
    close: () => gateway.close(),
    getOnboardingStartupState: () => gateway.getOnboardingStartupState(),
    init: () => gateway.init(),
    initCritical: () => gateway.initCritical(),
    recordDevDiagnostic: (input) =>
      gateway.recordDevDiagnostic(input as Parameters<GatewayService["recordDevDiagnostic"]>[0]),
    startDeferredInit: () => gateway.startDeferredInit(),
    validateCompanionAccessToken: (token) => gateway.validateCompanionAccessToken(token),
    validateDeviceAccessToken: (token) => gateway.validateDeviceAccessToken(token),
    verifyCompanionRequestSignature: (input) =>
      gateway.verifyCompanionRequestSignature(
        input as Parameters<GatewayService["verifyCompanionRequestSignature"]>[0],
      ),
  };
}
