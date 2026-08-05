import { randomUUID } from "node:crypto";
import type { ConnectorDiagnosticReport } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

export interface ConnectorDiagnosticsHost {
  readonly gatewaySql: Storage["gatewaySql"];
}

export async function recordConnectorHealthRun(
  host: ConnectorDiagnosticsHost,
  report: ConnectorDiagnosticReport,
): Promise<void> {
  await host.gatewaySql
    .prepare(
      `
      INSERT INTO connector_health_runs (
        health_run_id, connector_type, connector_id, status, summary_json, created_at
      ) VALUES (
        @healthRunId, @connectorType, @connectorId, @status, @summaryJson, @createdAt
      )
    `,
    )
    .run({
      healthRunId: randomUUID(),
      connectorType: report.connectorType,
      connectorId: report.connectorId,
      status: report.status,
      summaryJson: JSON.stringify(report),
      createdAt: report.checkedAt,
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
