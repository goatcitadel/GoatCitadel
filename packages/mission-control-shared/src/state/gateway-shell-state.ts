import type {
  EventStreamConnectionState,
  GatewayAccessPreflightResult,
} from "../api/shell-client";

export type GatewayAccessCheckingState = {
  status: "checking";
  message: string;
  healthDetail?: string;
};

export type ShellGatewayAccessStatus =
  | GatewayAccessCheckingState["status"]
  | GatewayAccessPreflightResult["status"]
  | "degraded-live-updates";

export interface ShellGatewayAccessState {
  status: ShellGatewayAccessStatus;
  label: string;
  tone: "warning" | "critical" | "muted" | "live";
  summary: string;
  nextStep: string;
  detail?: string;
}

export function deriveShellGatewayAccessState(
  access: GatewayAccessPreflightResult | GatewayAccessCheckingState,
  streamState?: EventStreamConnectionState,
): ShellGatewayAccessState {
  if (access.status === "checking") {
    return {
      status: "checking",
      label: "Checking gateway",
      tone: "muted",
      summary: access.message,
      nextStep: "Wait for the first access probe to finish.",
      detail: access.healthDetail,
    };
  }

  if (access.status === "ready") {
    if (streamState === "error" || streamState === "retrying") {
      return {
        status: "degraded-live-updates",
        label: "Live updates degraded",
        tone: "warning",
        summary: "Gateway access is verified, but realtime updates are reconnecting.",
        nextStep: "Keep working, or retry if you need the freshest live state right now.",
        detail: `Realtime stream state: ${streamState}. ${access.healthDetail}`,
      };
    }
    return {
      status: "ready",
      label: "Gateway ready",
      tone: "live",
      summary: access.message,
      nextStep: "Mission Control can load the live control surfaces now.",
      detail: access.healthDetail,
    };
  }

  if (access.status === "needs-auth") {
    return {
      status: "needs-auth",
      label: "Access required",
      tone: "warning",
      summary: access.message,
      nextStep: "Enter current credentials or approve this device from another signed-in GoatCitadel session.",
      detail: access.healthDetail,
    };
  }

  if (access.status === "unreachable") {
    return {
      status: "unreachable",
      label: "Gateway unreachable",
      tone: "critical",
      summary: access.message,
      nextStep: "Verify the gateway URL, the network path, and that the gateway is still running.",
      detail: access.healthDetail,
    };
  }

  return {
    status: "misconfigured",
    label: "Gateway misconfigured",
    tone: "critical",
    summary: access.message,
    nextStep: "Fix the gateway auth or probe configuration before continuing.",
    detail: access.healthDetail,
  };
}
