import {
  resolveMcpServerConnectionMode,
  type ConnectorDiagnosticReport,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type McpTemplateDiscoveryResult,
} from "@goatcitadel/contracts";
import { projectMcpPublicValue } from "./mcp-public-projection.js";
import type { McpRequesterScopeLastOutcome } from "./mcp-requester-resolution-service.js";

export interface McpDiagnosticsHost {
  requireFeatureEnabled(flag: string): void;
  listMcpTemplates(): Promise<Array<McpServerTemplateRecord & { installed: boolean }>>;
  requireMcpServer(serverId: string): Promise<{
    enabled: boolean;
    status: string;
    transport: string;
    command?: string;
    url?: string;
    policy: {
      blockedToolPatterns: string[];
      allowedToolPatterns: string[];
    };
  }>;
  pickConnectorDiagnosticAction(checks: ConnectorDiagnosticReport["checks"]): string | undefined;
  recordConnectorHealthRun(report: ConnectorDiagnosticReport): Promise<void>;
}

/** Exact non-secret resolver binding reference from a server's configuration. */
export interface McpRequesterScopeResolverRegistrationRef {
  resolverId: string;
  resolverVersion: string;
  configGeneration: number;
}

export type McpRequesterScopeResolverRegistrationPosture = "registered" | "resolver_missing" | "resolver_binding_drift";

/**
 * Read port the composed requester-scoped runtime exposes for operator
 * diagnostics (HX-415). It can answer only two questions — whether the exact
 * configured resolver binding is registered in the Gateway-owned registry, and
 * the last secret-free outcome classes for a serverId. It cannot resolve,
 * mutate, or reach any endpoint/header/credential material.
 */
export interface McpRequesterScopeDiagnosticsReadPort {
  resolveRegistrationPosture(
    ref: McpRequesterScopeResolverRegistrationRef,
  ): McpRequesterScopeResolverRegistrationPosture;
  loadLastOutcome(serverId: string): McpRequesterScopeLastOutcome | undefined;
}

/**
 * Secret-free per-server requester-scope posture (packet "API and operator
 * surface"): resolver identity/generation from the server's non-secret
 * configuration, the fixed `requesterContextRequired` marker, registry
 * registration posture (`resolver_missing` for stock deployments), and the
 * recorder's last outcome classes. It NEVER includes an endpoint or header
 * preview, URL component, credential, actor/channel identifier, resolver cause
 * text, or secret-derived hash.
 */
export interface McpRequesterScopePosture {
  serverId: string;
  connectionMode: "requester_scoped";
  requesterContextRequired: true;
  enabled: boolean;
  resolverId: string;
  resolverVersion: string;
  resolverConfigGeneration: number;
  resolverRegistration: McpRequesterScopeResolverRegistrationPosture;
  lastOutcome?: {
    outcomeClass: McpRequesterScopeLastOutcome["outcomeClass"];
    atMs: number;
    connectionGenerationClass: McpRequesterScopeLastOutcome["connectionGenerationClass"];
    expiryClass: McpRequesterScopeLastOutcome["expiryClass"];
    networkPolicyDecision: McpRequesterScopeLastOutcome["networkPolicyDecision"];
    profileDrift: boolean;
  };
}

export interface McpRequesterScopePostureHost {
  listMcpServers(): McpServerRecord[];
  requesterScopeDiagnostics: McpRequesterScopeDiagnosticsReadPort;
}

/**
 * Project the secret-free requester-scope posture for every requester-scoped
 * MCP server. Static servers are excluded entirely (their diagnostics remain
 * the existing template/health surfaces). Fields are copied one by one from
 * the non-secret configuration and the recorder — the server record is never
 * spread — and the finished rows additionally pass through the public MCP
 * projection as defense in depth before they are frozen. A malformed server
 * record is skipped fail-closed rather than projected partially.
 */
export function listMcpRequesterScopePostures(host: McpRequesterScopePostureHost): McpRequesterScopePosture[] {
  const postures: McpRequesterScopePosture[] = [];
  let servers: McpServerRecord[];
  try {
    servers = host.listMcpServers();
  } catch {
    return [];
  }
  for (const server of servers) {
    let posture: McpRequesterScopePosture | undefined;
    try {
      if (resolveMcpServerConnectionMode(server) !== "requester_scoped") continue;
      const resolution = server.requesterResolution;
      if (
        !resolution ||
        typeof resolution.resolverId !== "string" ||
        typeof resolution.resolverVersion !== "string" ||
        typeof resolution.configGeneration !== "number"
      ) {
        continue;
      }
      const registration = host.requesterScopeDiagnostics.resolveRegistrationPosture({
        resolverId: resolution.resolverId,
        resolverVersion: resolution.resolverVersion,
        configGeneration: resolution.configGeneration,
      });
      const lastOutcome = host.requesterScopeDiagnostics.loadLastOutcome(server.serverId);
      posture = {
        serverId: server.serverId,
        connectionMode: "requester_scoped",
        requesterContextRequired: true,
        enabled: server.enabled === true,
        resolverId: resolution.resolverId,
        resolverVersion: resolution.resolverVersion,
        resolverConfigGeneration: resolution.configGeneration,
        resolverRegistration: registration,
        ...(lastOutcome
          ? {
              lastOutcome: {
                outcomeClass: lastOutcome.outcomeClass,
                atMs: lastOutcome.atMs,
                connectionGenerationClass: lastOutcome.connectionGenerationClass,
                expiryClass: lastOutcome.expiryClass,
                networkPolicyDecision: lastOutcome.networkPolicyDecision,
                profileDrift: lastOutcome.profileDrift === true,
              },
            }
          : {}),
      };
    } catch {
      continue;
    }
    const projected = projectMcpPublicValue(posture);
    if (projected.lastOutcome) Object.freeze(projected.lastOutcome);
    postures.push(Object.freeze(projected));
  }
  return postures;
}

export async function listMcpTemplateDiscovery(host: McpDiagnosticsHost): Promise<McpTemplateDiscoveryResult[]> {
  host.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
  return (await host.listMcpTemplates()).map((template: McpServerTemplateRecord & { installed: boolean }) => {
    const checks: McpTemplateDiscoveryResult["dependencyChecks"] = [];
    if (template.transport === "stdio") {
      checks.push({
        key: "command",
        status: template.command?.trim() ? "pass" : "fail",
        message: template.command?.trim() ? `Command ${template.command} is configured.` : "Missing command.",
      });
    }
    if (template.transport === "http" || template.transport === "sse") {
      checks.push({
        key: "url",
        status: template.url?.trim() ? "pass" : "warn",
        message: template.url?.trim() ? `Endpoint ${template.url} provided.` : "Provide endpoint URL before connect.",
      });
    }
    if (template.authType !== "none") {
      checks.push({
        key: "auth",
        status: "warn",
        message: `${template.authType} credentials required before first connect.`,
      });
    } else {
      checks.push({
        key: "auth",
        status: "pass",
        message: "No auth required.",
      });
    }
    const missingCommand = checks.some((check) => check.key === "command" && check.status === "fail");
    // The url check is only ever pushed as "pass"/"warn", never "fail", so deriving missingUrl
    // from a "fail" status was always false and the "needs_url" readiness was unreachable —
    // an http/sse template with no URL was wrongly reported "ready". Derive it from the actual
    // condition instead.
    const missingUrl = (template.transport === "http" || template.transport === "sse") && !template.url?.trim();
    const readiness = missingCommand
      ? "needs_command"
      : missingUrl
        ? "needs_url"
        : template.authType !== "none"
          ? "needs_auth"
          : "ready";
    return {
      templateId: template.templateId,
      label: template.label,
      installed: template.installed,
      readiness,
      dependencyChecks: checks,
    };
  });
}

export async function runMcpServerHealthCheck(
  host: McpDiagnosticsHost,
  serverId: string,
): Promise<ConnectorDiagnosticReport> {
  host.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
  const server = await host.requireMcpServer(serverId);
  const checks: ConnectorDiagnosticReport["checks"] = [];
  checks.push({
    key: "enabled",
    status: server.enabled ? "pass" : "warn",
    message: server.enabled ? "MCP server is enabled." : "Server is disabled.",
  });
  checks.push({
    key: "status",
    status: server.status === "connected" ? "pass" : server.status === "connecting" ? "warn" : "fail",
    message: `Server status is ${server.status}.`,
  });
  if (server.transport === "stdio") {
    checks.push({
      key: "command",
      status: server.command?.trim() ? "pass" : "fail",
      message: server.command?.trim() ? `Command ${server.command} configured.` : "Missing stdio command.",
    });
  } else {
    checks.push({
      key: "url",
      status: server.url?.trim() ? "pass" : "fail",
      message: server.url?.trim() ? `URL ${server.url} configured.` : "Missing server URL.",
    });
  }
  checks.push({
    key: "policy",
    status:
      server.policy.blockedToolPatterns.length > 0 || server.policy.allowedToolPatterns.length > 0 ? "pass" : "warn",
    message:
      server.policy.blockedToolPatterns.length > 0 || server.policy.allowedToolPatterns.length > 0
        ? "Tool policy constraints are configured."
        : "Consider setting allow/block patterns for safer operation.",
  });
  const report: ConnectorDiagnosticReport = {
    connectorType: "mcp_server",
    connectorId: serverId,
    status: checks.some((check) => check.status === "fail")
      ? "error"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "ok",
    checks,
    recommendedNextAction: host.pickConnectorDiagnosticAction(checks),
    checkedAt: new Date().toISOString(),
  };
  await host.recordConnectorHealthRun(report);
  return report;
}
