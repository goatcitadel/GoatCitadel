// @vitest-environment happy-dom
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
// The connection details name the bound workspace through a query; this suite renders without a QueryClient.
vi.mock("../../data/use-workspace-name", () => ({
  useWorkspaceNameLookup: () => () => undefined,
  useWorkspaceName: () => undefined,
  useActiveWorkspaceLabel: () => "Current workspace",
}));
const prefs = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (original) => {
  const actual = await original<typeof import("@goatcitadel/mission-control-shared/state/ui-preferences")>();
  return {
    ...actual,
    useUiPreferences: () => ({ ...actual.useUiPreferences(), showTechnicalDetails: prefs.showTechnicalDetails }),
  };
});
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
// Fields are named by their visible <label> text alone (WCAG 2.5.3), so the helper finds them the same way.
const field = (label: string) =>
  view.root
    .find((node) => node.type === "label" && [node.props.children].flat()[0] === label)
    .find((node) => node.type === "input" || node.type === "select" || node.type === "textarea");
const change = async (label: string, value: string) => {
  await act(async () => field(label).props.onChange({ target: { value } }));
};
beforeEach(() => {
  vi.resetAllMocks();
  prefs.showTechnicalDetails = false;
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
  it("opens the add form on the catalog entry a Set up link asked for, then reports it handled once", async () => {
    const handled = vi.fn();
    api.fetchIntegrationCatalog.mockResolvedValue({
      items: [
        { catalogId: saved.catalogId, kind: saved.kind, key: saved.key, label: "Fixture", operatorActions: [] },
        { catalogId: "automation.gmail", kind: "automation", key: "gmail", label: "Gmail", operatorActions: [] },
      ],
    });
    await act(async () => {
      view = create(
        <IntegrationManagementSettings
          workspaceId="default"
          createRequest={{ catalogId: "automation.gmail" }}
          onCreateRequestHandled={handled}
        />,
      );
    });
    expect(view.root.findByProps({ "aria-label": "Integration catalog" }).props.value).toBe("automation.gmail");
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("reviews a disabled new connection without writes and confirms exact owner readback", async () => {
    await act(async () => {
      view = create(<IntegrationManagementSettings workspaceId="default" />);
    });
    await click("Add integration connection");
    expect(field("Connection label").props["aria-label"]).toBeUndefined();
    await change("Connection label", saved.label);
    await click("Review new connection");
    expect(api.createIntegrationConnection).not.toHaveBeenCalled();
    expect(text(view.root)).toContain(`Catalog: ${saved.catalogId}.`);
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
    expect(text(view.root)).toContain("Saved status: Set up, not checked");
    expect(text(view.root)).toContain("Not checked yet");
  });
  it("offers no plugin trust view", async () => {
    await act(async () => {
      view = create(<IntegrationManagementSettings workspaceId="default" />);
    });
    const views = view.root
      .findAllByType("div")
      .find((node) => node.props.role === "group" && node.props["aria-label"] === "Management views")!;
    expect(views.findAllByType("button").map((node) => text(node))).toEqual([
      "Imported connectors",
      "Delivery records",
      "Google Meet preparation",
    ]);
    expect(text(view.root)).not.toContain("Plugin trust");
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("plugins"))).toBe(false);
  });
  it("keeps the reviewed version out of the delete dialog while technical details are off", async () => {
    api.fetchIntegrationConnections.mockResolvedValue({ items: [saved] });
    await act(async () => {
      view = create(
        <IntegrationManagementSettings
          workspaceId="default"
          selection={{ connectionId: saved.connectionId, nonce: 1 }}
        />,
      );
    });
    await click("Delete integration connection");
    expect(text(view.root.findByProps({ role: "dialog" }))).not.toContain("Reviewed version");
  });
  it("cancels deletion without calling the owner", async () => {
    api.fetchIntegrationConnections.mockResolvedValue({ items: [saved] });
    await act(async () => {
      view = create(
        <IntegrationManagementSettings
          workspaceId="default"
          selection={{ connectionId: saved.connectionId, nonce: 1 }}
        />,
      );
    });
    prefs.showTechnicalDetails = true;
    await act(async () =>
      view.update(
        <IntegrationManagementSettings
          workspaceId="default"
          selection={{ connectionId: saved.connectionId, nonce: 1 }}
        />,
      ),
    );
    await click("Delete integration connection");
    const dialog = view.root.findByProps({ role: "dialog" });
    const details = dialog.findAllByType("details");
    expect(details).toHaveLength(1);
    expect(text(details[0]!)).toContain("Reviewed version: " + saved.revision);
    expect(text(dialog).replace(text(details[0]!), "")).not.toContain("Reviewed version");
    await click("Keep integration");
    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();
  });
});
