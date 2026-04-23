import type { GatewayService } from "./gateway-service.js";
import { AuthAdminRouteService } from "./auth-admin-route-service.js";
import { ApprovalsRouteService } from "./approvals-route-service.js";
import { DurableRouteService } from "./durable-route-service.js";
import { MemoryRouteService } from "./memory-route-service.js";
import { OrchestrationRouteService } from "./orchestration-route-service.js";
import { RuntimeLifecycleRouteService } from "./runtime-lifecycle-route-service.js";

export interface GatewayRouteServices {
  authAdmin: AuthAdminRouteService;
  approvals: ApprovalsRouteService;
  durable: DurableRouteService;
  memory: MemoryRouteService;
  orchestration: OrchestrationRouteService;
  runtimeLifecycle: RuntimeLifecycleRouteService;
}

export function createGatewayRouteServices(gateway: GatewayService): GatewayRouteServices {
  return {
    authAdmin: new AuthAdminRouteService(gateway),
    approvals: new ApprovalsRouteService(gateway),
    durable: new DurableRouteService(gateway),
    memory: new MemoryRouteService(gateway),
    orchestration: new OrchestrationRouteService(gateway),
    runtimeLifecycle: new RuntimeLifecycleRouteService(gateway),
  };
}
