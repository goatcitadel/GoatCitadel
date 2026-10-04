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
  readonly providerId?: string | null;
  readonly model?: string | null;
  readonly elapsedMs?: number;
  readonly outputPreview?: string;
  readonly error?: string;
}

export function fetchDevStatus(signal?: AbortSignal): Promise<DevVerificationStatus> {
  return request<DevVerificationStatus>(`${DEV_VERIFICATION}/status`, { signal });
}

export function fetchRouteManifest(signal?: AbortSignal): Promise<RouteManifest> {
  return request<RouteManifest>(`${DEV_VERIFICATION}/route-access-manifest`, { signal });
}

export function seedWorkspace(label: string, signal?: AbortSignal): Promise<SeededWorkspace> {
  return postJson(
    `${DEV_VERIFICATION}/seed`,
    { workspaceName: label, sessionTitle: `${label} session`, sessionCount: 1, longThreadTurns: 2 },
    signal,
  );
}

export function seedChatApprovalScenario(scope: SessionScope, signal?: AbortSignal): Promise<ChatApprovalScenario> {
  return postJson(`${DEV_VERIFICATION}/chat-approval-scenario`, scope, signal);
}

export function seedChatUserInputScenario(scope: SessionScope, signal?: AbortSignal): Promise<ChatUserInputScenario> {
  return postJson(`${DEV_VERIFICATION}/chat-user-input-scenario`, scope, signal);
}

export function seedMemoryItem(input: MemoryItemSeedInput, signal?: AbortSignal): Promise<SeededMemoryItem> {
  return postJson(`${DEV_VERIFICATION}/memory-item-seed`, input, signal);
}

export function seedDurableRecovery(signal?: AbortSignal): Promise<DurableRecoverySeed> {
  // Fastify rejects an empty body sent with a JSON content type, so send an empty object.
  return postJson(`${DEV_VERIFICATION}/durable-recovery-seed`, {}, signal);
}

export function exerciseProvider(
  input: { readonly scenario: "simple" },
  signal?: AbortSignal,
): Promise<ProviderExerciseResult> {
  return postJson(`${DEV_VERIFICATION}/provider-exercise`, input, signal);
}

function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body), signal });
}
