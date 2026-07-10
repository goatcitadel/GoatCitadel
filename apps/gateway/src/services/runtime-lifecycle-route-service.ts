import {
  redactStructuredSecrets,
  type RuntimeLifecycleQuery,
  type RuntimeLifecycleResponse,
  type RuntimeLifecycleLink,
  type SessionTimelineItem,
  type TranscriptEvent,
} from "@goatcitadel/contracts";
import {
  RuntimeLifecycleExportService,
  type RuntimeLifecycleExportQueryWithSiem,
} from "./runtime-lifecycle-export-service.js";

export interface RuntimeLifecycleRoutePort {
  getRuntimeLifecycle(input: RuntimeLifecycleQuery): Promise<RuntimeLifecycleResponse>;
  getTranscript(sessionId: string): Promise<TranscriptEvent[]>;
  listSessionTimeline(sessionId: string, limit?: number): Promise<SessionTimelineItem[]>;
}

export class RuntimeLifecycleRouteService {
  private readonly exportService: RuntimeLifecycleExportService;

  public constructor(private readonly lifecycle: RuntimeLifecycleRoutePort) {
    this.exportService = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: (input) =>
        this.lifecycle.getRuntimeLifecycle(input).then(withRuntimeLifecycleLinks).then(projectRuntimeLifecyclePublic),
      getTranscript: (sessionId) => this.lifecycle.getTranscript(sessionId),
      listSessionTimeline: (sessionId, limit) => this.lifecycle.listSessionTimeline(sessionId, limit),
    });
  }

  public getLifecycle(input: RuntimeLifecycleQuery) {
    return this.lifecycle
      .getRuntimeLifecycle(input)
      .then(withRuntimeLifecycleLinks)
      .then(projectRuntimeLifecyclePublic);
  }

  public exportLifecycle(input: RuntimeLifecycleExportQueryWithSiem) {
    return this.exportService.exportBundle(input);
  }

  public exportLifecycleSiemNdjson(input: RuntimeLifecycleExportQueryWithSiem) {
    return this.exportService.exportSiemNdjson(input);
  }
}

function projectRuntimeLifecyclePublic(response: RuntimeLifecycleResponse): RuntimeLifecycleResponse {
  return redactStructuredSecrets(response).value;
}

function withRuntimeLifecycleLinks(response: RuntimeLifecycleResponse): RuntimeLifecycleResponse {
  return {
    ...response,
    links: buildRuntimeLifecycleLinks(response),
  };
}

function buildRuntimeLifecycleLinks(response: RuntimeLifecycleResponse): RuntimeLifecycleLink[] {
  const query = buildRuntimeLifecycleLinkQuery(response);
  if (!query) {
    return [];
  }
  const encoded = query.toString();
  return [
    {
      rel: "self",
      label: "Runtime lifecycle",
      href: `/api/v1/runtime/lifecycle?${encoded}`,
      method: "GET",
      contentType: "application/json",
    },
    {
      rel: "export_bundle",
      label: "Runtime lifecycle bundle",
      href: `/api/v1/runtime/lifecycle/export?${encoded}&includeTranscript=true&includeTimeline=true&format=bundle`,
      method: "GET",
      contentType: "application/json",
      format: "bundle",
    },
    {
      rel: "export_trust_report",
      label: "Trust report",
      href: `/api/v1/runtime/lifecycle/export?${encoded}&includeTranscript=true&includeTimeline=true&format=trust_report`,
      method: "GET",
      contentType: "application/json",
      format: "trust_report",
    },
    {
      rel: "export_siem_ndjson",
      label: "SIEM NDJSON",
      href: `/api/v1/runtime/lifecycle/export?${encoded}&includeTimeline=true&format=siem_ndjson`,
      method: "GET",
      contentType: "application/x-ndjson",
      format: "siem_ndjson",
    },
  ];
}

function buildRuntimeLifecycleLinkQuery(response: RuntimeLifecycleResponse): URLSearchParams | undefined {
  const params = new URLSearchParams();
  for (const key of ["runId", "turnId", "sessionId", "approvalId", "taskId"] as const) {
    const value = response.canonical[key] ?? response.query[key];
    if (value?.trim()) {
      params.set(key, value.trim());
      return params;
    }
  }
  return undefined;
}
