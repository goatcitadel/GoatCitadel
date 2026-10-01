import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectorDiagnosticReport, McpServerRecord } from "@goatcitadel/contracts";
import { McpConfigurationReport, __resetMcpConfigurationReportsForTests } from "./McpConfigurationReport";
const api = vi.hoisted(() => ({ fetchMcpServer: vi.fn(), runMcpServerHealthCheck: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
const server: McpServerRecord = {
  serverId: "server",
  revision: "a".repeat(64),
  connectionRevision: "c".repeat(64),
  label: "Fixture",
  transport: "stdio",
  command: "node",
  authType: "none",
  enabled: false,
  status: "disconnected",
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [] },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
const report: ConnectorDiagnosticReport = {
  connectorType: "mcp_server",
  connectorId: "server",
  status: "warn",
  checkedAt: "2026-09-30T00:00:01Z",
  checks: [{ key: "enabled", status: "warn", message: "Server is disabled." }],
};
let root: ReactTestRenderer | undefined;
async function render(scope = "workspace", record = server) {
  await act(async () => {
    const element = (
      <StrictMode>
        <McpConfigurationReport
          server={record}
          scope={scope}
          button={(label, click, disabled) => (
            <button type="button" onClick={click} disabled={disabled}>
              {label}
            </button>
          )}
        />
      </StrictMode>
    );
    if (root) root.update(element);
    else root = create(element);
  });
}
const content = () => JSON.stringify(root!.toJSON());
const click = () => act(async () => root!.root.findByType("button").props.onClick());
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpConfigurationReportsForTests();
  api.fetchMcpServer.mockResolvedValue(server);
  api.runMcpServerHealthCheck.mockResolvedValue(report);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});
it("records only after an explicit action and confirms unchanged metadata around the report", async () => {
  await render();
  expect(api.runMcpServerHealthCheck).not.toHaveBeenCalled();
  await click();
  expect(api.runMcpServerHealthCheck).toHaveBeenCalledExactlyOnceWith("server");
  expect(api.fetchMcpServer).toHaveBeenCalledTimes(2);
  expect(content()).toContain("Server is disabled.");
  expect(content()).toContain("does not prove live connectivity");
});
it("withholds stale saved metadata before recording", async () => {
  await render();
  api.fetchMcpServer.mockResolvedValue({ ...server, revision: "b".repeat(64) });
  await click();
  expect(api.runMcpServerHealthCheck).not.toHaveBeenCalled();
  expect(content()).toContain("metadata changed");
});
it("cancels an away-back preflight without recording", async () => {
  let resolve!: (value: McpServerRecord) => void;
  api.fetchMcpServer.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  await click();
  await render("other");
  await render();
  await act(async () => resolve(server));
  expect(api.runMcpServerHealthCheck).not.toHaveBeenCalled();
});
it.each(["lost", "foreign", "metadata-drift"])("retains an unknown %s result across remount", async (kind) => {
  await render();
  if (kind === "lost") api.runMcpServerHealthCheck.mockRejectedValue(new Error("lost"));
  if (kind === "foreign") api.runMcpServerHealthCheck.mockResolvedValue({ ...report, connectorId: "foreign" });
  if (kind === "metadata-drift")
    api.fetchMcpServer
      .mockResolvedValueOnce(server)
      .mockResolvedValue({ ...server, connectionRevision: "d".repeat(64) });
  await click();
  await act(async () => root!.unmount());
  root = undefined;
  await render("other");
  expect(root!.root.findByType("button").props.disabled).toBe(true);
  expect(content()).toContain("outcome is unconfirmed");
});
it("withholds a previous report when the displayed configuration changes", async () => {
  await render();
  await click();
  await render("workspace", { ...server, revision: "b".repeat(64) });
  expect(content()).not.toContain("Server is disabled.");
  expect(content()).toContain("previous report is withheld");
});
it.each([false, true])("classifies the exact disabled owner gate only when uncommitted: %s", async (committed) => {
  api.runMcpServerHealthCheck.mockRejectedValue(
    new ApiRequestError("disabled", {
      kind: "http",
      method: "POST",
      path: "/api/v1/mcp/servers/server/health-check",
      status: 409,
      body: {
        code: "STATE_CONFLICT",
        details: { flag: "connectorDiagnosticsV1Enabled" },
        ...(committed ? { mutationCommitted: true } : {}),
      },
    }),
  );
  await render();
  await click();
  expect(root!.root.findByType("button").props.disabled).toBe(committed);
  expect(content()).toContain(committed ? "outcome is unconfirmed" : "No configuration report was recorded");
});
