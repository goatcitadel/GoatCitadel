import type { DemoBootstrapResponse, DemoBootstrapStateResponse } from "@goatcitadel/contracts";

import { request } from "./client-core.js";

export async function fetchDemoState(options: { signal?: AbortSignal } = {}): Promise<DemoBootstrapStateResponse> {
  return request<DemoBootstrapStateResponse>("/api/v1/demo/state", options.signal ? { signal: options.signal, cache: "no-store" } : undefined);
}

export async function bootstrapDemo(): Promise<DemoBootstrapResponse> {
  return request<DemoBootstrapResponse>("/api/v1/demo/bootstrap", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export type { DemoBootstrapResponse, DemoBootstrapStateResponse };
