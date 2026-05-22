import type { UpdateScoutReport, UpdateScoutRequest } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function runUpdateScout(input: UpdateScoutRequest): Promise<UpdateScoutReport> {
  return request<UpdateScoutReport>("/api/v1/update-scout/reports", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
