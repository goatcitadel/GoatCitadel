import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationSettingsOwner } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { IntegrationConnectionDetails } from "./IntegrationConnectionDetails";

vi.mock("../../data/use-workspace-name", () => ({
  useWorkspaceNameLookup: () => (workspaceId?: string) => (workspaceId === "ws_research" ? "Research" : undefined),
}));

const connection = {
  connectionId: "conn_1",
  catalogId: "github",
  label: "GitHub",
  enabled: true,
  status: "connected",
  workspaceId: "ws_research",
  revision: "rev-abc",
  updatedAt: "2026-09-30T12:00:00Z",
};
const owner = {
  selectedConnection: connection,
  connectionMutation: { locked: false, pending: false },
  review: { required: false },
  data: { connectorDiagnosticsEnabled: true },
  diagnostics: {
    connectorType: "integration_connection",
    connectorId: "conn_1",
    status: "warn",
    checks: [{ key: "auth", status: "fail", message: "Token expired" }],
    checkedAt: "2026-09-30T12:05:00Z",
  },
  lastOperatorActionResult: {
    actionLabel: "Sync issues",
    connectionId: "conn_1",
    catalogId: "github",
    actionId: "sync",
    status: "executed",
    message: "Synced.",
    checkedAt: "2026-09-30T12:06:00Z",
    durableWriteback: { status: "recorded", replayOutcome: "duplicate", checkedAt: "2026-09-30T12:06:00Z" },
  },
  selectedCatalog: { operatorActions: [] },
  operatorActionInputs: {},
  operatorActionIdempotencyKeys: {},
  operatorReview: null,
} as unknown as IntegrationSettingsOwner;

describe("integration connection details", () => {
  it("presents statuses, workspace and times in plain words and keeps raw evidence out of view", () => {
    const markup = renderToStaticMarkup(<IntegrationConnectionDetails owner={owner} />);
    expect(markup).toContain("Configured status: Connected");
    expect(markup).toContain("Bound workspace: Research.");
    expect(markup).toContain("Passed with warnings");
    expect(markup).toContain("Failed · Token expired");
    expect(markup).toContain("Sync issues:");
    expect(markup).toContain("Duplicate, not sent again");
    expect(markup).toContain('dateTime="2026-09-30T12:05:00.000Z"');
    for (const raw of ["ws_research", "conn_1", "rev-abc", "2026-09-30T12:06:00Z", "executed", '"status"'])
      expect(markup).not.toContain(raw);
  });
});
