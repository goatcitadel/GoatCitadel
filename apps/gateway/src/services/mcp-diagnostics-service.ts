import type {
  ConnectorDiagnosticReport,
  McpServerTemplateRecord,
  McpTemplateDiscoveryResult,
} from "@goatcitadel/contracts";

export interface McpDiagnosticsHost {
  requireFeatureEnabled(flag: string): void;
  listMcpTemplates(): Array<McpServerTemplateRecord & { installed: boolean }>;
  requireMcpServer(serverId: string): {
    enabled: boolean;
    status: string;
    transport: string;
    command?: string;
    url?: string;
    policy: {
      blockedToolPatterns: string[];
      allowedToolPatterns: string[];
    };
  };
  pickConnectorDiagnosticAction(checks: ConnectorDiagnosticReport["checks"]): string | undefined;
  recordConnectorHealthRun(report: ConnectorDiagnosticReport): void;
}

export function listMcpTemplateDiscovery(host: McpDiagnosticsHost): McpTemplateDiscoveryResult[] {
  host.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
  return host.listMcpTemplates().map((template: McpServerTemplateRecord & { installed: boolean }) => {
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

export function runMcpServerHealthCheck(host: McpDiagnosticsHost, serverId: string): ConnectorDiagnosticReport {
  host.requireFeatureEnabled("connectorDiagnosticsV1Enabled");
  const server = host.requireMcpServer(serverId);
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
  host.recordConnectorHealthRun(report);
  return report;
}
