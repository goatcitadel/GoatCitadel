import { describe, expect, it } from "vitest";
import type { ConnectorDiagnosticReport } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { recordConnectorHealthRun } from "./connector-diagnostics-helpers.js";

describe("connector diagnostics persistence", () => {
  it("records the complete report through the canonical connector health schema", () => {
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: ".",
      auditDir: ".",
    });
    const report: ConnectorDiagnosticReport = {
      connectorType: "integration_connection",
      connectorId: "11111111-1111-1111-1111-111111111111",
      status: "warn",
      checks: [
        { key: "status", status: "pass", message: "Connection is enabled." },
        { key: "auth", status: "warn", message: "Credentials are not configured." },
      ],
      recommendedNextAction: "Provide credentials and rerun diagnostics.",
      checkedAt: "2026-07-30T06:17:26.000Z",
      probe: {
        kind: "verification_probe",
        mode: "loopback",
        checkedAt: "2026-07-30T06:17:25.000Z",
        steps: [
          {
            key: "fixture_reachable",
            label: "Fixture reachable",
            status: "pass",
            message: "The deterministic loopback fixture responded.",
          },
        ],
      },
    };

    try {
      expect(() => recordConnectorHealthRun({ gatewaySql: storage.gatewaySql }, report)).not.toThrow();

      const row = storage.gatewaySql
        .prepare(
          `
            SELECT connector_type, connector_id, status, summary_json, created_at
            FROM connector_health_runs
          `,
        )
        .get<{
          connector_type: string;
          connector_id: string;
          status: string;
          summary_json: string;
          created_at: string;
        }>();

      expect(row).toEqual({
        connector_type: report.connectorType,
        connector_id: report.connectorId,
        status: report.status,
        summary_json: JSON.stringify(report),
        created_at: report.checkedAt,
      });
    } finally {
      storage.close();
    }
  });
});
