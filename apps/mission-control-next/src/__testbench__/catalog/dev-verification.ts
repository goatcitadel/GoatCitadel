import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import type { RouteManifest } from "../runner/routes";
import type { DevVerificationStatus } from "../gateway-target/detect-target";

const DEV_VERIFICATION = "/api/v1/dev/verification";

export interface SessionScope {
  readonly sessionId: string;
  readonly workspaceId: string;
}

export interface SeededWorkspace {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sessionIds: readonly string[];
}

export interface ChatApprovalScenario extends SessionScope {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly approvalId: string;
  readonly approvalWaitRunId: string;
  readonly chatTurnDurableRunId: string;
}

export interface ChatUserInputScenario extends SessionScope {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly promptId: string;
  readonly chatTurnDurableRunId: string;
}

export interface MemoryItemSeedInput {
  readonly workspaceId: string;
  readonly namespace: string;
  readonly title: string;
  readonly content: string;
}

export interface SeededMemoryItem extends MemoryItemSeedInput {
  readonly itemId: string;
  readonly lifecycleState: string;
}

export interface DurableRecoverySeed {
  readonly orphanRecovery: {
    readonly approvalId: string;
    readonly runId: string;
    readonly status: string;
    readonly leaseExpiresAt: string;
  };
  readonly deadLetterRecovery: {
    readonly approvalId: string;
    readonly runId: string;
    readonly status: string;
    readonly deadLetterId: string;
  };
}

export interface ProviderExerciseResult {
  readonly ok: boolean;
  readonly providerId?: string;
  readonly model?: string;
  readonly elapsedMs?: number;
  readonly outputPreview?: string;
  readonly error?: string;
}

export function fetchDevStatus(): Promise<DevVerificationStatus> {
  return request<DevVerificationStatus>(`${DEV_VERIFICATION}/status`);
}

export function fetchRouteManifest(): Promise<RouteManifest> {
  return request<RouteManifest>(`${DEV_VERIFICATION}/route-access-manifest`);
}

export function seedWorkspace(label: string): Promise<SeededWorkspace> {
  return postJson(`${DEV_VERIFICATION}/seed`, {
    workspaceName: label,
    sessionTitle: `${label} session`,
    sessionCount: 1,
    longThreadTurns: 2,
  });
}

export function seedChatApprovalScenario(scope: SessionScope): Promise<ChatApprovalScenario> {
  return postJson(`${DEV_VERIFICATION}/chat-approval-scenario`, scope);
}

export function seedChatUserInputScenario(scope: SessionScope): Promise<ChatUserInputScenario> {
  return postJson(`${DEV_VERIFICATION}/chat-user-input-scenario`, scope);
}

export function seedMemoryItem(input: MemoryItemSeedInput): Promise<SeededMemoryItem> {
  return postJson(`${DEV_VERIFICATION}/memory-item-seed`, input);
}

export function seedDurableRecovery(): Promise<DurableRecoverySeed> {
  // Fastify rejects an empty body sent with a JSON content type, so send an empty object.
  return postJson(`${DEV_VERIFICATION}/durable-recovery-seed`, {});
}

export function exerciseProvider(input: { readonly scenario: "simple" }): Promise<ProviderExerciseResult> {
  return postJson(`${DEV_VERIFICATION}/provider-exercise`, input);
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}
