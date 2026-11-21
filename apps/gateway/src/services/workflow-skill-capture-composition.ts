import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import { WorkflowSkillCaptureService } from "./workflow-skill-capture-service.js";

// Match Chat terminal delivery so post-commit effect retries have the same time to settle.
const WORKFLOW_CAPTURE_ADMISSION_RELEASE_TIMEOUT_MS = 30_000;

/** Construct the shared workflow capture owner for explicit Chat route bindings. */
export function createWorkflowSkillCaptureForGateway(
  gateway: Pick<GatewayRouteCompositionPort, "storage" | "config" | "chatMessageRouteRuntimeHost">,
): WorkflowSkillCaptureService {
  return new WorkflowSkillCaptureService({
    storage: gateway.storage,
    config: gateway.config,
    waitForTerminalAdmission: async (identity) => {
      const outcome = await gateway.chatMessageRouteRuntimeHost.durableRunService.awaitTerminalChatAdmissionRelease({
        ...identity,
        timeoutMs: WORKFLOW_CAPTURE_ADMISSION_RELEASE_TIMEOUT_MS,
      });
      return outcome.recoveryOutcome === "released" || outcome.recoveryOutcome === "already_released";
    },
  });
}
