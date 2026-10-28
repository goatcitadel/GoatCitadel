// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ConnectorDiagnosticReport } from "@goatcitadel/contracts";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join(" ");

const report: ConnectorDiagnosticReport = {
  connectorType: "integration_connection",
  connectorId: "matrix-fixture",
  status: "ok",
  checkedAt: "2026-10-28T03:00:00.000Z",
  checks: [
    { key: "delivery_posture", status: "pass", message: "Matrix outbound is text-only." },
    { key: "url", status: "pass", message: "The homeserver URL is set." },
  ],
};

describe("Classic connection diagnostics", () => {
  it("shows the stored `delivery_posture` key as sending and receiving, without changing the key", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DiagnosticsPanel report={report} ariaLabel="Integration connection diagnostic checks" />);
    });
    const copy = text(renderer.root);
    expect(copy).toContain("Sending and receiving");
    expect(copy).not.toMatch(/posture/iu);
    expect(report.checks.map((check) => check.key)).toEqual(["delivery_posture", "url"]);
    renderer.unmount();
  });

  it("leaves every other check key as it was", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<DiagnosticsPanel report={report} ariaLabel="Integration connection diagnostic checks" />);
    });
    expect(text(renderer.root)).toContain("url");
    renderer.unmount();
  });
});
