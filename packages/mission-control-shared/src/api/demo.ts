import type { DemoBootstrapResponse, DemoBootstrapStateResponse } from "@goatcitadel/contracts";

import { request } from "./client-core.js";

export async function fetchDemoState(): Promise<DemoBootstrapStateResponse> {
  return request<DemoBootstrapStateResponse>("/api/v1/demo/state");
}

export async function bootstrapDemo(): Promise<DemoBootstrapResponse> {
  return request<DemoBootstrapResponse>("/api/v1/demo/bootstrap", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export type { DemoBootstrapResponse, DemoBootstrapStateResponse };
