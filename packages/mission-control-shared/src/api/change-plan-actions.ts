import type { ChangePlanCreateInput, ChangePlanRequest, ChangePlanResponseInput } from "@goatcitadel/contracts";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { ChangePlanClientContext } from "./chat.js";
import type { OpenAICodexDevicePollResponse, OpenAICodexDeviceStartResponse } from "./platform.js";
import { request } from "./client-core.js";

export interface CreateChangePlanClientInput extends ChangePlanClientContext {
  /** The generic create route takes chat or settings only; Capabilities installs have their own route. */
  surface?: Exclude<ChangePlanCreateInput["origin"]["surface"], "system" | "capabilities">;
  request: ChangePlanRequest;
  idempotencyKey?: string;
}

function changePlanActorBody(context: ChangePlanClientContext): ChangePlanClientContext {
  return {
    workspaceId: context.workspaceId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

/** Canonical Evolution Control Plane resource API. */
export async function createChangePlan(input: CreateChangePlanClientInput): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>("/api/v1/change-plans", {
    method: "POST",
    body: JSON.stringify({
      ...changePlanActorBody(input),
      surface: input.surface ?? "chat",
      request: input.request,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    }),
  });
}

export async function respondToChangePlan(
  planId: string,
  context: ChangePlanClientContext,
  input: ChangePlanResponseInput,
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/responses`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function confirmChangePlan(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionNonce: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/confirmations`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function cancelChangePlan(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionNonce: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/cancellations`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function requestChangePlanRollback(
  planId: string,
  context: ChangePlanClientContext,
  expectedRevision: number,
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/rollback-requests`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), expectedRevision }),
  });
}

export async function submitChangePlanProviderSecret(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string; apiKey: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/provider-secret`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function submitChangePlanGatewayAuthCredential(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string; credential: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/gateway-auth-credential`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function submitChangePlanChannelSecrets(
  planId: string,
  context: ChangePlanClientContext,
  input: {
    expectedRevision: number;
    actionId: string;
    actionNonce: string;
    values: Readonly<Record<string, string>>;
  },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/channel-secrets`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function submitChangePlanManagedSourceSelection(
  planId: string,
  context: ChangePlanClientContext,
  input: {
    expectedRevision: number;
    actionId: string;
    actionNonce: string;
    rootPath: string;
  },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/managed-source-selections`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function completeChangePlanProviderOAuth(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/provider-oauth-completions`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function startChangePlanProviderOAuth(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string },
): Promise<OpenAICodexDeviceStartResponse> {
  return request<OpenAICodexDeviceStartResponse>(
    `/api/v1/change-plans/${encodeURIComponent(planId)}/provider-oauth-starts`,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
    },
  );
}

export async function pollChangePlanProviderOAuth(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string; flowId: string },
): Promise<OpenAICodexDevicePollResponse> {
  return request<OpenAICodexDevicePollResponse>(
    `/api/v1/change-plans/${encodeURIComponent(planId)}/provider-oauth-polls`,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
    },
  );
}
