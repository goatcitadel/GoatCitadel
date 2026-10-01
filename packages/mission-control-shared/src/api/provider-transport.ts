import type { LlmProviderRequestConfig } from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse } from "./platform.js";
import { request } from "./client-core.js";

/** Transport-only update. Public profile/routing changes keep their Settings change-plan path. */
export function updateProviderTransport(input: {
  expectedRevision: number;
  providerId: string;
  request: LlmProviderRequestConfig;
}): Promise<LlmRuntimeConfigResponse> {
  return request("/api/v1/llm/config", {
    method: "PATCH",
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      upsertProvider: { providerId: input.providerId, request: input.request },
    }),
  });
}
