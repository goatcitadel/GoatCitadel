import type { DeploymentProfile } from "@goatcitadel/contracts";

const RESTRICTED_BROWSER_STATE_TOOLS = new Set([
  "browser.cookies.get",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.get",
  "browser.storage.set",
  "browser.storage.clear",
]);

export interface ComputerUseSafety {
  requiresVerification: boolean;
  requiresConfirmation: boolean;
  verified: boolean;
  confirmed: boolean;
}

export interface BrowserRuntimeGuardrailViolation {
  statusCode: 403 | 409;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * Server-controlled facts about the request that the model CANNOT influence via
 * its own tool `args`. These are derived by trusted server code (e.g. from a
 * resolved policy context carrying an operator-approved grant / approval-replay
 * marker) and passed into the guardrail out-of-band.
 *
 * The `remote_hardened` deployment profile is the network-exposed surface where
 * prompt-injected page content is the exact threat. There, a mutating
 * `browser.interact` must be gated by one of these server-controlled signals —
 * never by `args.verifyStep` / `args.confirmBeforeSubmit`, which the model
 * supplies in the very same call it is trying to authorize.
 */
export interface BrowserRuntimeServerVerification {
  /**
   * True when the mutating browser action has been authorized by a server-tracked
   * operator approval (an approved pending-action replay or a matched operator
   * grant recorded on the request's policy context). Absent/false means the guard
   * has NO trustworthy signal and the mutating action must be blocked.
   */
  operatorApproved?: boolean;
}

export function isRestrictedBrowserStateTool(toolName: string): boolean {
  return RESTRICTED_BROWSER_STATE_TOOLS.has(toolName);
}

/**
 * Server-controlled markers on a resolved tool policy context that indicate an
 * operator-sanctioned invocation. Only trusted server code stamps these — the
 * model cannot forge them (HTTP invoke/evaluate routes recompute the policy
 * context from scratch and never accept a client-supplied one; the approved
 * external-runtime replay path stamps the context from a persisted approval).
 */
export interface ServerControlledApprovalMarkers {
  /** Set when this invocation is an approved Code Mode wrapper replay. */
  approvedCodeModeRunId?: string;
  /** Set when the policy engine matched a persisted operator grant. */
  matchedGrantId?: string;
}

/**
 * Decide whether a resolved policy context proves a SERVER-CONTROLLED operator
 * approval for the remote_hardened mutating-browser guard. Returns false when no
 * trustworthy marker is present, so the guard blocks a self-authorizing model.
 */
export function policyContextHasOperatorApproval(
  policyContext: ServerControlledApprovalMarkers | undefined | null,
): boolean {
  if (!policyContext) {
    return false;
  }
  return Boolean(policyContext.approvedCodeModeRunId) || Boolean(policyContext.matchedGrantId);
}

export function evaluateComputerUseSafety(toolName: string, args: Record<string, unknown>): ComputerUseSafety {
  const isBrowserInteract = toolName === "browser.interact";
  const steps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
  const mutatingStep = steps.some((step) => {
    const action = typeof step.action === "string" ? step.action : "";
    return action === "click" || action === "type" || action === "press";
  });
  const requiresVerification = isBrowserInteract && mutatingStep;
  const requiresConfirmation = isBrowserInteract && mutatingStep;
  const verified = args.verifyStep === true;
  const confirmed = args.confirmBeforeSubmit === true;
  return {
    requiresVerification,
    requiresConfirmation,
    verified,
    confirmed,
  };
}

export function evaluateDeploymentProfileToolAccess(
  profile: DeploymentProfile,
  toolName: string,
  args: Record<string, unknown>,
  serverVerification?: BrowserRuntimeServerVerification,
): BrowserRuntimeGuardrailViolation | null {
  if (profile !== "trusted_local" && isRestrictedBrowserStateTool(toolName)) {
    return {
      statusCode: 403,
      reason: "Browser cookies and storage tools are restricted to the trusted_local deployment profile.",
      details: {
        toolName,
        deploymentProfile: profile,
      },
    };
  }

  if (profile !== "remote_hardened") {
    return null;
  }

  const safety = evaluateComputerUseSafety(toolName, args);
  const isMutatingBrowserAction = safety.requiresVerification || safety.requiresConfirmation;
  if (!isMutatingBrowserAction) {
    return null;
  }

  // SECURITY (slice 3.3): remote_hardened is the network-exposed profile where
  // prompt-injected page content is the exact threat. A mutating browser.interact
  // MUST be authorized by a server-controlled operator approval — never by the
  // model-supplied args.verifyStep / args.confirmBeforeSubmit, which the model can
  // set in the very same call it is trying to authorize. If no server-tracked
  // approval is present, the action is blocked (there is no model-satisfiable path).
  if (serverVerification?.operatorApproved === true) {
    return null;
  }

  return {
    statusCode: 409,
    reason:
      "Computer-use guardrail: in the remote_hardened deployment profile a mutating browser action requires an operator approval. It cannot be self-authorized by the tool call.",
    details: {
      ...safety,
      deploymentProfile: profile,
      requiresOperatorApproval: true,
      // Reached only when the action is NOT server-approved (the approved branch
      // returns above), so this is always false — surfaced for auditability.
      operatorApproved: false,
    },
  };
}
