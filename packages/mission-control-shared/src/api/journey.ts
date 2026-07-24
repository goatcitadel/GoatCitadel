import type { JourneyTimelinePage, JourneyTimelineQuery } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchJourneyTimeline(input: JourneyTimelineQuery): Promise<JourneyTimelinePage> {
  const params = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.includeGlobal) params.set("includeGlobal", "true");
  appendList(params, "eventTypes", input.eventTypes);
  appendList(params, "subjectKinds", input.subjectKinds);
  appendList(params, "actions", input.actions);
  if (input.subjectId) params.set("subjectId", input.subjectId);
  if (input.fingerprint) params.set("fingerprint", input.fingerprint);
  if (input.sessionId) params.set("sessionId", input.sessionId);
  appendList(params, "trustDispositions", input.trustDispositions);
  appendList(params, "poisoningStatuses", input.poisoningStatuses);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  return request<JourneyTimelinePage>(`/api/v1/journey/events?${params.toString()}`);
}

function appendList(params: URLSearchParams, key: string, values: readonly string[] | undefined): void {
  if (values?.length) params.set(key, values.join(","));
}
