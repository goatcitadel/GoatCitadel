import type {
  LocalAiDownloadJob,
  LocalAiDownloadRequest,
  LocalAiEndpointRegistration,
  LocalAiEndpointRegistrationRequest,
  LocalAiReadinessResponse,
  LocalAiServeJob,
  LocalAiServeRequest,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchLocalAiReadiness(): Promise<LocalAiReadinessResponse> {
  return request<LocalAiReadinessResponse>("/api/v1/local-ai/readiness");
}

export async function startLocalAiDownload(input: LocalAiDownloadRequest): Promise<LocalAiDownloadJob> {
  return request<LocalAiDownloadJob>("/api/v1/local-ai/downloads", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function startLocalAiServe(input: LocalAiServeRequest): Promise<LocalAiServeJob> {
  return request<LocalAiServeJob>("/api/v1/local-ai/serve", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function stopLocalAiServe(jobId: string): Promise<LocalAiServeJob> {
  return request<LocalAiServeJob>(`/api/v1/local-ai/serve/${encodeURIComponent(jobId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function registerLocalAiEndpoint(
  input: LocalAiEndpointRegistrationRequest,
): Promise<LocalAiEndpointRegistration> {
  return request<LocalAiEndpointRegistration>("/api/v1/local-ai/endpoints/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
