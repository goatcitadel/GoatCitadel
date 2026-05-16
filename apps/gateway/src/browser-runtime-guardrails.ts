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

export function isRestrictedBrowserStateTool(toolName: string): boolean {
  return RESTRICTED_BROWSER_STATE_TOOLS.has(toolName);
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
  if (safety.requiresVerification && !safety.verified) {
    return {
      statusCode: 409,
      reason:
        "Computer-use guardrail: this mutating browser action requires step verification (set args.verifyStep=true).",
      details: {
        ...safety,
        deploymentProfile: profile,
      },
    };
  }
  if (safety.requiresConfirmation && !safety.confirmed) {
    return {
      statusCode: 409,
      reason: "Computer-use guardrail: confirm-before-submit required (set args.confirmBeforeSubmit=true).",
      details: {
        ...safety,
        deploymentProfile: profile,
      },
    };
  }

  return null;
}
