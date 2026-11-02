import { composeGatewayNativeWorkerHandler } from "./remote-worker-gateway-handler-composition.js";
import type { CompanionPrincipalPurpose, DatabaseCutoverRequest, LlmRuntimeConfig } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import type { GatewayRouteServices } from "./gateway-route-services.js";
import { GatewayService } from "./gateway-service.js";
import { getChannelStreamRuntime } from "./channel-stream-runtime-registry.js";
import type { McpRequesterResolverRegistryInput } from "./mcp-requester-resolution.js";
import type { CronRunSnapshot } from "./gateway/cron-automation-service.js";
import type { BrowserSessionRuntimeService } from "./browser-session-runtime-service.js";
import type { BrowserErrandService } from "./browser-errands/browser-errand-service.js";
import type { ReviewReadinessService } from "./review-readiness-service.js";
import type { RuntimeAuthorityProjectionService } from "./runtime-authority-projection-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";
import type { SharedHostLifecycleAdmissionPort } from "./shared-host-lifecycle-service.js";
import type { WorkPassportService } from "./work-passport-service.js";
import type { EngineeringLearningService } from "./engineering-learning-service.js";
import type { RemoteWorkerNativeRequestHandler } from "./remote-worker-native-tls-listener.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";

type GatewayLogger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export interface GatewayRuntimePort {
  readonly browserSessionRuntimeService: BrowserSessionRuntimeService;
  readonly browserErrandService: Pick<BrowserErrandService, "getStatus" | "stop">;
  readonly mutationIdempotencyStore: MutationIdempotencyStore;
  readonly reviewReadinessService: ReviewReadinessService;
  readonly runtimeAuthorityProjectionService: RuntimeAuthorityProjectionService;
  readonly workPassportService: WorkPassportService;
  readonly engineeringLearningService: EngineeringLearningService;
  readonly routeServices: GatewayRouteServices;
  createRemoteWorkerAdmissionNativeRequestHandler(
    config: EnabledRemoteWorkerRuntimeConfig,
  ): Promise<RemoteWorkerNativeRequestHandler | undefined>;
  attachDevDiagnosticsLogger(logger: GatewayLogger): void;
  init(): Promise<void>;
  initCritical(): Promise<void>;
  startDeferredInit(signal?: AbortSignal): Promise<void>;
  recordDevDiagnostic(input: unknown): void;
  getOnboardingStartupState(): { completed?: boolean };
  stopExternalAdmission?(): Promise<void>;
  close(): Promise<void>;
}

export interface GatewayAuthValidationPort {
  getOnboardingStartupState(): { completed?: boolean };
  validateDeviceAccessToken(
    token: string,
  ): Promise<
    { actorId: string; deviceId: string; grantId: string; principalPurpose: CompanionPrincipalPurpose } | undefined
  >;
  validateCompanionAccessToken(token: string): Promise<
    | {
        actorId: string;
        deviceId: string;
        grantId: string;
        sessionId: string;
        principalPurpose: CompanionPrincipalPurpose;
      }
    | undefined
  >;
  verifyCompanionRequestSignature(input: unknown): Promise<void>;
}

export type GatewayRuntimeInstance = GatewayRuntimePort & GatewayAuthValidationPort;

export interface GatewayAdminPort extends GatewayRuntimePort, GatewayAuthValidationPort {
  createBackup(input: { name?: string; outputPath?: string }): Promise<unknown>;
  findCronRunById(runId: string): Promise<CronRunSnapshot | undefined>;
  getAuthCredentialPlan(): unknown;
  getLlmConfig(): LlmRuntimeConfig;
  getRetentionPolicy(): unknown;
  listBackups(limit?: number): Promise<unknown>;
  pruneRetention(input: { dryRun?: boolean }): Promise<unknown>;
  readSettingsRevision(): number;
  resolveGatewayInstallToken(input: {
    token?: string;
    generateWhenMissing?: boolean;
    persistToEnv?: boolean;
  }): Promise<unknown>;
  runCronJobNow(jobId: string): Promise<{ jobId: string; runId: string; status: "ok" | "pending" }>;
  runDatabaseCutover(input: DatabaseCutoverRequest): Promise<unknown>;
  updateRetentionPolicy(input: {
    realtimeEventsDays?: number;
    backupsKeep?: number;
    transcriptsDays?: number;
    auditDays?: number;
  }): unknown;
  verifyDatabaseCutover(input: { source: string; target?: string }): Promise<unknown>;
}

export interface GatewayRuntimeFactoryOptions {
  sharedHostLifecycle?: SharedHostLifecycleAdmissionPort;
  /** Trusted composition input only; the stock application registers no resolvers. */
  mcpRequesterResolvers?: McpRequesterResolverRegistryInput;
}

export function createGatewayRuntime(
  config: GatewayRuntimeConfig,
  options: GatewayRuntimeFactoryOptions = {},
): GatewayRuntimeInstance {
  return createGatewayRuntimeFacade(new GatewayService(config, options));
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
    readSettingsRevision: () => gateway.readSettingsRevision(),
    resolveGatewayInstallToken: (input) => gateway.resolveGatewayInstallToken(input),
    runCronJobNow: (jobId) => gateway.cronAutomationService.runCronJobNow(jobId),
    runDatabaseCutover: (input) => gateway.runDatabaseCutover(input),
    updateRetentionPolicy: (input) => gateway.updateRetentionPolicy(input),
    verifyDatabaseCutover: (input) => gateway.verifyDatabaseCutover(input),
  };
}

function createGatewayRuntimeFacade(gateway: GatewayService): GatewayRuntimeInstance {
  // Resolved at call time so admin/cron runtimes that only init() never construct the stream runtime.
  const channelStreams = () => getChannelStreamRuntime(gateway);
  return {
    get browserSessionRuntimeService() {
      return gateway.browserSessionRuntimeService;
    },
    get browserErrandService() {
      return gateway.browserErrandService;
    },
    get mutationIdempotencyStore() {
      return gateway.mutationIdempotencyStore;
    },
    get reviewReadinessService() {
      return gateway.reviewReadinessService;
    },
    get runtimeAuthorityProjectionService() {
      return gateway.runtimeAuthorityProjectionService;
    },
    get workPassportService() {
      return gateway.workPassportService;
    },
    get engineeringLearningService() {
      return gateway.engineeringLearningService;
    },
    get routeServices() {
      return gateway.routeServices;
    },
    createRemoteWorkerAdmissionNativeRequestHandler: (config) => composeGatewayNativeWorkerHandler(gateway, config),
    attachDevDiagnosticsLogger: (logger) => gateway.attachDevDiagnosticsLogger(logger),
    close: async () => {
      await channelStreams().close();
      await gateway.close();
    },
    getOnboardingStartupState: () => gateway.getOnboardingStartupState(),
    init: () => gateway.init(),
    initCritical: () => gateway.initCritical(),
    recordDevDiagnostic: (input) =>
      gateway.recordDevDiagnostic(input as Parameters<GatewayService["recordDevDiagnostic"]>[0]),
    stopExternalAdmission: async () => {
      await channelStreams().close();
      await gateway.stopExternalAdmission();
    },
    startDeferredInit: async (signal) => {
      // Serving path only, installed before deferred init connects Discord:
      // voice-only Discord messages are dropped before pairing/allowlist side
      // effects unless inbound channel voice is on (the bridge re-checks).
      gateway.discordRuntimeService.setVoiceInboundGate(
        async () => await gateway.isFeatureEnabled("channelVoiceInboundV1Enabled"),
      );
      // A saved Discord bot token is a secure-storage reference; the runtime reads this connection's own key through
      // the same custody read a send uses, and an unset reader leaves such a connection down.
      gateway.discordRuntimeService.setSecretReferenceReader((secretRef, owner) =>
        gateway.resolveConnectionSecret({ ref: secretRef }, "ref", "refEnv", undefined, owner),
      );
      await gateway.startDeferredInit(signal);
      // Persistent channel streams start only on the serving path, never for admin/cron CLIs that call init().
      if (!signal?.aborted) await channelStreams().sync();
    },
    validateCompanionAccessToken: (token) => gateway.validateCompanionAccessToken(token),
    validateDeviceAccessToken: (token) => gateway.validateDeviceAccessToken(token),
    verifyCompanionRequestSignature: (input) =>
      gateway.verifyCompanionRequestSignature(
        input as Parameters<GatewayService["verifyCompanionRequestSignature"]>[0],
      ),
  };
}
