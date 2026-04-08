import { randomUUID } from "node:crypto";
import type { ConnectorDiagnosticReport } from "@goatcitadel/contracts";
import type { GatewayService } from "./gateway-service.js";

export type ConnectorDiagnosticsHost = GatewayService;

export function recordConnectorHealthRun(host: ConnectorDiagnosticsHost, report: ConnectorDiagnosticReport): void {
  host.gatewaySql
    .prepare(
      `
      INSERT INTO connector_health_runs (
        health_run_id, connector_type, connector_id, status, checks_json, recommendation, checked_at
      ) VALUES (
        @healthRunId, @connectorType, @connectorId, @status, @checksJson, @recommendation, @checkedAt
      )
    `,
    )
    .run({
      healthRunId: randomUUID(),
      connectorType: report.connectorType,
      connectorId: report.connectorId,
      status: report.status,
      checksJson: JSON.stringify(report.checks),
      recommendation: report.recommendedNextAction ?? null,
      checkedAt: report.checkedAt,
    });
}

export function pickConnectorDiagnosticAction(checks: ConnectorDiagnosticReport["checks"]): string | undefined {
  if (checks.some((check) => check.key === "status" && check.status === "fail")) {
    return "Reconnect the connector and resolve the reported status error first.";
  }
  if (checks.some((check) => check.key === "auth" && check.status !== "pass")) {
    return "Provide valid credentials and rerun health check.";
  }
  if (checks.some((check) => check.key === "url" && check.status !== "pass")) {
    return "Set a reachable URL/endpoint and rerun health check.";
  }
  return checks.some((check) => check.status === "warn")
    ? "Review warning checks and tighten policy before production use."
    : undefined;
}
