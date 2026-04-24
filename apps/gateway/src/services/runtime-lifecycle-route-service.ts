import type {
  RuntimeLifecycleExportQuery,
  RuntimeLifecycleQuery,
  RuntimeLifecycleResponse,
  SessionTimelineItem,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { RuntimeLifecycleExportService } from "./runtime-lifecycle-export-service.js";

export interface RuntimeLifecycleRoutePort {
  getRuntimeLifecycle(input: RuntimeLifecycleQuery): Promise<RuntimeLifecycleResponse>;
  getTranscript(sessionId: string): Promise<TranscriptEvent[]>;
  listSessionTimeline(sessionId: string, limit?: number): Promise<SessionTimelineItem[]>;
}

export class RuntimeLifecycleRouteService {
  private readonly exportService: RuntimeLifecycleExportService;

  public constructor(private readonly lifecycle: RuntimeLifecycleRoutePort) {
    this.exportService = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: (input) => this.lifecycle.getRuntimeLifecycle(input),
      getTranscript: (sessionId) => this.lifecycle.getTranscript(sessionId),
      listSessionTimeline: (sessionId, limit) => this.lifecycle.listSessionTimeline(sessionId, limit),
    });
  }

  public getLifecycle(input: RuntimeLifecycleQuery) {
    return this.lifecycle.getRuntimeLifecycle(input);
  }

  public exportLifecycle(input: RuntimeLifecycleExportQuery) {
    return this.exportService.exportBundle(input);
  }
}
