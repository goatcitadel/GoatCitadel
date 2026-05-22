import type { ResearchSearchRequest, ResearchSearchResponse } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function runResearchSearch(input: ResearchSearchRequest): Promise<ResearchSearchResponse> {
  return request<ResearchSearchResponse>("/api/v1/research/search", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
