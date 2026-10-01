import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { IntegrationManagementSettings } from "./IntegrationManagementSettings";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";

const api = vi.hoisted(() => ({
  fetchIntegrationCatalog: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchIntegrationConnection: vi.fn(),
  fetchSettings: vi.fn(),
  fetchIntegrationFormSchema: vi.fn(),
  createIntegrationConnection: vi.fn(),
  deleteIntegrationConnection: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));
const saved: IntegrationConnection = {
  connectionId: "fixture",
  revision: "a".repeat(64),
  catalogId: "productivity.fixture",
  key: "fixture",
  kind: "productivity",
  label: "Reviewed fixture",
  enabled: false,
  status: "connected",
  config: { endpoint: "http://fixture.invalid" },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
let view: ReactTestRenderer;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const button = (name: string) => view.root.findAllByType("button").find((node) => text(node) === name)!;
const click = async (name: string) => {
  await act(async () => button(name).props.onClick());
};
const change = async (name: string, value: string) => {
  await act(async () => view.root.findByProps({ "aria-label": name }).props.onChange({ target: { value } }));
};
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  __resetSessionViewStateForTests();
  __resetIntegrationConnectionMutationsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected external request");
    }),
  );
  api.fetchIntegrationCatalog.mockResolvedValue({
    items: [{ catalogId: saved.catalogId, kind: saved.kind, key: saved.key, label: "Fixture", operatorActions: [] }],
  });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [] });
  api.fetchIntegrationConnection.mockResolvedValue(saved);
  api.fetchSettings.mockResolvedValue({ features: {} });
  api.createIntegrationConnection.mockResolvedValue(saved);
  api.fetchIntegrationFormSchema.mockResolvedValue({
    catalogId: saved.catalogId,
    title: "Fixture",
    fields: [{ key: "endpoint", label: "Endpoint", type: "text", defaultValue: "http://fixture.invalid" }],
  });
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  vi.unstubAllGlobals();
});
describe("native integration management", () => {
  it("reviews a disabled new connection without writes and confirms exact owner readback", async () => {
    await act(async () => {
      view = create(<IntegrationManagementSettings workspaceId="default" />);
    });
    await click("Add integration connection");
    await change("Integration connection label", saved.label);
    await click("Review new connection");
    expect(api.createIntegrationConnection).not.toHaveBeenCalled();
    expect(text(view.root)).toContain("Creation has no resource revision precondition");
    await click("Keep current connection");
    expect(api.createIntegrationConnection).not.toHaveBeenCalled();
    await click("Review new connection");
    await click("Apply reviewed connection");
    expect(api.createIntegrationConnection).toHaveBeenCalledExactlyOnceWith({
      catalogId: saved.catalogId,
      label: saved.label,
      enabled: false,
      config: saved.config,
    });
    expect(api.fetchIntegrationConnection).toHaveBeenCalledWith(saved.connectionId);
    expect(text(view.root)).toContain("Connection Reviewed fixture created.");
    expect(text(view.root)).toContain("Saved status: connected");
  });
  it("cancels deletion without calling the owner", async () => {
    api.fetchIntegrationConnections.mockResolvedValue({ items: [saved] });
    await act(async () => {
      view = create(<IntegrationManagementSettings workspaceId="default" />);
    });
    await click("Reviewed fixture · Disabled");
    await click("Delete integration connection");
    expect(text(view.root)).toContain("Reviewed revision:");
    await click("Keep integration");
    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();
  });
});
