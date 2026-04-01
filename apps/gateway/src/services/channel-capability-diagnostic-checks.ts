import type { ChannelCapabilities, ConnectorDiagnosticReport } from "@goatcitadel/contracts";

export function buildChannelCapabilityDiagnosticChecks(
  capabilities: ChannelCapabilities,
): ConnectorDiagnosticReport["checks"] {
  const checks: ConnectorDiagnosticReport["checks"] = [
    {
      key: "inbound_mode",
      status: "pass",
      message: buildInboundModeMessage(capabilities),
    },
    {
      key: "runtime_posture",
      status: capabilities.runtimePosture.inboundReadiness === "ready" ? "pass" : "warn",
      message: `Runtime posture: ${capabilities.runtimePosture.operatorSummary}`,
    },
    {
      key: "runtime_policy",
      status: "pass",
      message: buildRuntimePolicyMessage(capabilities),
    },
  ];

  checks.push({
    key: "setup_ready",
    status: capabilities.setupReady ? "pass" : "warn",
    message: capabilities.setupReady
      ? "Setup posture: ready."
      : `Setup posture: follow-up required (${capabilities.setupDiagnostics.length} diagnostic item${capabilities.setupDiagnostics.length === 1 ? "" : "s"}).`,
  });

  if (capabilities.setupDiagnostics.length > 0) {
    checks.push({
      key: "setup_diagnostics",
      status: "warn",
      message: `Setup diagnostics: ${capabilities.setupDiagnostics.join(" ")}`,
    });
  }

  if (capabilities.supportNotes.length > 0) {
    checks.push({
      key: "support_notes",
      status: "pass",
      message: `Support notes: ${capabilities.supportNotes.join(" ")}`,
    });
  }

  return checks;
}

function buildInboundModeMessage(capabilities: ChannelCapabilities): string {
  const inboundModes = capabilities.inboundModes.length > 0 ? capabilities.inboundModes : ["none"];
  if (inboundModes.length === 1 && inboundModes[0] === "none") {
    return "Inbound mode: none (outbound-only connection).";
  }
  return `Inbound modes: ${inboundModes.join(", ")}.`;
}

function buildRuntimePolicyMessage(capabilities: ChannelCapabilities): string {
  const enabledFlags = Object.entries(capabilities.runtimePolicy)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .sort();
  if (enabledFlags.length === 0) {
    return "Runtime policy gates: none.";
  }
  return `Runtime policy gates: ${enabledFlags.join(", ")}.`;
}
