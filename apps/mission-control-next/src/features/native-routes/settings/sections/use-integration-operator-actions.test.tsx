import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection, IntegrationCatalogEntry } from "@goatcitadel/contracts";
import { useIntegrationSettings, type IntegrationSettingsOwner } from "./use-integration-settings";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../library/use-form-dirty";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { __resetIntegrationConnectionMutationsForTests } from "../integration-connection-mutation";

const api = vi.hoisted(() => ({
  fetchIntegrationCatalog: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchIntegrationConnection: vi.fn(),
  fetchSettings: vi.fn(),
  fetchIntegrationFormSchema: vi.fn(),
  invokeIntegrationConnectionAction: vi.fn(),
  fetchIntegrationConnectionDiagnostics: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
const connection: IntegrationConnection = {
  connectionId: "fixture",
  revision: "a".repeat(64),
  catalogId: "productivity.fixture",
  key: "fixture",
  kind: "productivity",
  label: "Fixture",
  enabled: true,
  status: "connected",
  config: {},
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
const action = { actionId: "read", label: "Read fixture", description: "Read the fixture", capability: "read" };
const catalog: IntegrationCatalogEntry = {
  catalogId: connection.catalogId,
  key: "fixture",
  kind: "productivity",
  label: "Fixture",
  description: "Fixture integration",
  maturity: "beta",
  capabilities: ["read"],
  authMethods: [],
  operatorActions: [action],
};
const result = {
  connectionId: connection.connectionId,
  catalogId: connection.catalogId,
  actionId: action.actionId,
  status: "executed",
  message: "Read acknowledged",
  checkedAt: "2026-09-30T01:00:00Z",
};
let view: ReactTestRenderer;
let owner: IntegrationSettingsOwner;
function Harness({ workspace = "default" }: { workspace?: string }) {
  owner = useIntegrationSettings(workspace);
  return null;
}
async function mount() {
  await act(async () => {
    view = create(<Harness />);
  });
  await act(async () => owner.connectionSelectionGuard.requestTransition(connection.connectionId));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  __resetSessionViewStateForTests();
  __resetIntegrationConnectionMutationsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected transport in hermetic fixture");
    }),
  );
  api.fetchIntegrationCatalog.mockResolvedValue({ items: [catalog] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [connection] });
  api.fetchIntegrationConnection.mockResolvedValue(connection);
  api.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: true } });
  api.invokeIntegrationConnectionAction.mockResolvedValue(result);
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  vi.unstubAllGlobals();
});
describe("shared reviewed integration actions", () => {
  it("does not invoke during review and admits only one exact action across simultaneous confirms", async () => {
    await mount();
    await act(async () => owner.handleOperatorAction(action));
    expect(api.invokeIntegrationConnectionAction).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.all([owner.confirmOperatorAction(), owner.confirmOperatorAction()]);
    });
    expect(api.invokeIntegrationConnectionAction).toHaveBeenCalledExactlyOnceWith("fixture", "read", {});
    expect(owner.lastOperatorActionResult?.status).toBe("executed");
  });
  it("withholds a changed advertised action before dispatch", async () => {
    await mount();
    await act(async () => owner.handleOperatorAction(action));
    api.fetchIntegrationCatalog.mockResolvedValue({
      items: [{ ...catalog, operatorActions: [{ ...action, capability: "write" }] }],
    });
    await act(async () => owner.confirmOperatorAction());
    expect(api.invokeIntegrationConnectionAction).not.toHaveBeenCalled();
    expect(owner.notice?.message).toContain("changed");
    expect(owner.connectionMutation.locked).toBe(false);
  });
  it("cancels a preflight after switching workspace away and back", async () => {
    await mount();
    await act(async () => owner.handleOperatorAction(action));
    const pending = deferred<IntegrationConnection>();
    api.fetchIntegrationConnection.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = owner.confirmOperatorAction();
    });
    await act(async () => view.update(<Harness workspace="other" />));
    await act(async () => view.update(<Harness />));
    await act(async () => {
      pending.resolve(connection);
      await operation;
    });
    expect(api.invokeIntegrationConnectionAction).not.toHaveBeenCalled();
    expect(owner.operatorReview).toBeNull();
  });
  it.each(["lost response", "foreign receipt"])("retains an uncertain lock across remount for %s", async (mode) => {
    await mount();
    await act(async () => owner.handleOperatorAction(action));
    if (mode === "lost response")
      api.invokeIntegrationConnectionAction.mockRejectedValueOnce(new Error("Lost response"));
    else api.invokeIntegrationConnectionAction.mockResolvedValueOnce({ ...result, connectionId: "foreign" });
    await act(async () => owner.confirmOperatorAction());
    expect(owner.connectionMutation.phase).toBe("uncertain");
    await act(async () => view.unmount());
    await mount();
    expect(owner.connectionMutation.locked).toBe(true);
    await act(async () => owner.handleOperatorAction(action));
    await act(async () => owner.confirmOperatorAction());
    expect(api.invokeIntegrationConnectionAction).toHaveBeenCalledTimes(1);
  });
  it("rejects a foreign diagnostic without replacing current evidence", async () => {
    await mount();
    api.fetchIntegrationConnectionDiagnostics.mockResolvedValue({
      connectorId: "foreign",
      connectorType: "integration_connection",
      status: "ok",
      checks: [],
      checkedAt: result.checkedAt,
    });
    await act(async () => owner.handleDiagnostics());
    expect(owner.diagnostics).toBeNull();
    expect(owner.notice?.message).toContain("did not identify");
  });
});
