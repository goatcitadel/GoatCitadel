import type { RuntimeLifecycleExportQuery, RuntimeLifecycleQuery } from "@goatcitadel/contracts";
import type { GatewayService } from "./gateway-service.js";
import { RuntimeLifecycleExportService } from "./runtime-lifecycle-export-service.js";

type RuntimeLifecycleRouteGateway = Pick<
  GatewayService,
  "getRuntimeLifecycle" | "getTranscript" | "listSessionTimeline"
>;

export class RuntimeLifecycleRouteService {
  private readonly exportService: RuntimeLifecycleExportService;

  public constructor(private readonly gateway: RuntimeLifecycleRouteGateway) {
    this.exportService = new RuntimeLifecycleExportService({
      getRuntimeLifecycle: (input) => this.gateway.getRuntimeLifecycle(input),
      getTranscript: (sessionId) => this.gateway.getTranscript(sessionId),
      listSessionTimeline: (sessionId, limit) => this.gateway.listSessionTimeline(sessionId, limit),
    });
  }

  public getLifecycle(input: RuntimeLifecycleQuery) {
    return this.gateway.getRuntimeLifecycle(input);
  }

  public exportLifecycle(input: RuntimeLifecycleExportQuery) {
    return this.exportService.exportBundle(input);
  }
}
