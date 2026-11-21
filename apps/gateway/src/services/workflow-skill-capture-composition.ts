import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import { WorkflowSkillCaptureService } from "./workflow-skill-capture-service.js";

// The reconciliation owner bounds each call to 30 seconds. Post-commit effects can
// take longer than that after the answer is visible while still retaining the admission.
const TERMINAL_ADMISSION_WAIT_MS = 30_000;
const TERMINAL_ADMISSION_WAIT_ATTEMPTS = 3;

/** Construct the shared workflow capture owner for explicit Chat route bindings. */
export function createWorkflowSkillCaptureForGateway(
  gateway: Pick<GatewayRouteCompositionPort, "storage" | "config" | "chatMessageRouteRuntimeHost">,
): WorkflowSkillCaptureService {
  return new WorkflowSkillCaptureService({
    storage: gateway.storage,
    config: gateway.config,
    waitForTerminalAdmission: async (identity) => {
      const durableRuns = gateway.chatMessageRouteRuntimeHost.durableRunService;
      for (let attempt = 0; attempt < TERMINAL_ADMISSION_WAIT_ATTEMPTS; attempt += 1) {
        const { recoveryOutcome, durableRunStatus } = await durableRuns.awaitTerminalChatAdmissionRelease({
          ...identity,
          timeoutMs: TERMINAL_ADMISSION_WAIT_MS,
        });
        if (recoveryOutcome === "released" || recoveryOutcome === "already_released") return true;
        const stillFinishing =
          (recoveryOutcome === "not_terminal" && durableRunStatus === "running") ||
          (recoveryOutcome === "reconciliation_pending" && durableRunStatus === "completed");
        if (!stillFinishing) return false;
      }
      return false;
    },
  });
}
