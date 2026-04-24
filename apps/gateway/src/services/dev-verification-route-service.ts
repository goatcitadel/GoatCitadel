import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatSessionCreateInput,
  ChatSessionRecord,
  LlmRuntimeConfig,
  RealtimeEvent,
  WorkspaceCreateInput,
  WorkspaceRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";

export interface DevVerificationRouteDependencies {
  readonly storage: Storage;
  createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest>;
  createChatCompletion(input: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  createChatCompletionStream(input: ChatCompletionRequest): AsyncGenerator<Record<string, unknown>>;
  createChatSession(input: ChatSessionCreateInput): ChatSessionRecord;
  createWorkspace(input: WorkspaceCreateInput): WorkspaceRecord;
  getLlmConfig(): LlmRuntimeConfig;
  getProviderSecretStatus(providerId: string): {
    providerId: string;
    hasSecret: boolean;
    source: "none" | "keychain" | "env" | "inline";
  };
  getRealtimeEventSequenceBounds(): { oldestSequence?: number; newestSequence?: number };
  isDevDiagnosticsEnabled(): boolean;
  listDevDiagnostics(
    input?: Parameters<GatewayDevDiagnosticsService["list"]>[0],
  ): ReturnType<GatewayDevDiagnosticsService["list"]>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent;
}

export class DevVerificationRouteService {
  public readonly storage: Storage;

  public constructor(private readonly deps: DevVerificationRouteDependencies) {
    this.storage = deps.storage;
  }

  public createApproval(input: ApprovalCreateInput) {
    return this.deps.createApproval(input);
  }

  public createChatCompletion(input: ChatCompletionRequest) {
    return this.deps.createChatCompletion(input);
  }

  public createChatCompletionStream(input: ChatCompletionRequest) {
    return this.deps.createChatCompletionStream(input);
  }

  public createChatSession(input: ChatSessionCreateInput) {
    return this.deps.createChatSession(input);
  }

  public createWorkspace(input: WorkspaceCreateInput) {
    return this.deps.createWorkspace(input);
  }

  public getLlmConfig() {
    return this.deps.getLlmConfig();
  }

  public getProviderSecretStatus(providerId: string) {
    return this.deps.getProviderSecretStatus(providerId);
  }

  public getRealtimeEventSequenceBounds() {
    return this.deps.getRealtimeEventSequenceBounds();
  }

  public isDevDiagnosticsEnabled() {
    return this.deps.isDevDiagnosticsEnabled();
  }

  public listDevDiagnostics(input?: Parameters<GatewayDevDiagnosticsService["list"]>[0]) {
    return this.deps.listDevDiagnostics(input);
  }

  public publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ) {
    return this.deps.publishRealtime(eventType, source, payload, options);
  }
}
