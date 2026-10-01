import type { McpRemotePreviewItem, McpServerModeToolDescriptor } from "@goatcitadel/contracts";
import { createEmptyMcpRemotePreview, createEmptyMcpServerModeManifest } from "./helpers/mcp-helpers";

export function manifestFixture(count = 1) {
  const tools: McpServerModeToolDescriptor[] = Array.from({ length: count }, (_, index) => ({
    name: `fixture.read_${index}`,
    title: `Fixture descriptor ${index}`,
    description: "Recorded read-only descriptor.",
    capabilityId: `fixture-${index}`,
    capabilityKind: "tool",
    inputSchema: {},
    gatewayCallable: true,
    serverModeState: "call_preview",
    blockers: [],
    governance: ["Gateway policy applies."],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }));
  const base = createEmptyMcpServerModeManifest();
  return {
    ...base,
    generatedAt: "2026-09-30T20:00:00.000Z",
    tools,
    summary: {
      ...base.summary,
      inspectableCapabilities: count,
      gatewayCallableCapabilities: count,
      exportedToolDescriptors: count,
    },
  };
}
export function remoteFixture(count = 1) {
  const items: McpRemotePreviewItem[] = Array.from({ length: count }, (_, index) => ({
    source: "template",
    id: `remote-${index}`,
    label: `Remote template ${index}`,
    transport: "http",
    authType: "none",
    authReadiness: "not_required",
    trustTier: "restricted",
    posture: "configured_only",
    callableState: "not_callable",
    invocationState: "configured_not_callable",
    runtimePath: "generic_remote_http_sse",
    createAllowed: true,
    transportRuntimeSupported: true,
    runtimeSupported: false,
    operatorNextAction: "Review configuration before registration.",
    blockers: ["Not installed."],
    governance: ["Gateway policy applies."],
    evidence: {},
    installed: false,
  }));
  const base = createEmptyMcpRemotePreview();
  return {
    ...base,
    generatedAt: "2026-09-30T20:00:01.000Z",
    items,
    summary: { ...base.summary, remoteTemplates: count, configuredOnly: count, notCallable: count },
  };
}
