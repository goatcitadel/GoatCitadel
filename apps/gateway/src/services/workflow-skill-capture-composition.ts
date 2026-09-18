import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import { WorkflowSkillCaptureService } from "./workflow-skill-capture-service.js";

/** Construct the shared workflow capture owner for explicit Chat route bindings. */
export function createWorkflowSkillCaptureForGateway(
  gateway: Pick<GatewayRouteCompositionPort, "storage" | "config">,
): WorkflowSkillCaptureService {
  return new WorkflowSkillCaptureService({
    storage: gateway.storage,
    rootDir: gateway.config.rootDir,
    candidateRoot: gateway.config.assistant.capabilities.candidateRoot,
  });
}
