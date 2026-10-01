// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";
import { IntegrationConnectionsSettings } from "./IntegrationConnectionsSettings";

const api = vi.hoisted(() => ({
  fetchIntegrationConnections: vi.fn(),
  fetchIntegrationConnection: vi.fn(),
  updateIntegrationConnection: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api, isApiRequestError: () => false }));
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({ ConfirmModal: () => null }));
const connection = (id: string, patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  connectionId: id,
  catalogId: "productivity.github",
  revision: "a".repeat(64),
  kind: "productivity",
  key: "github",
  label: `GitHub ${id}`,
  enabled: false,
  status: "paused",
  config: { token: "[REDACTED]" },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  ...patch,
});
let items: IntegrationConnection[];
let view: ReactTestRenderer;
let client: QueryClient;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view.root.findAllByType("button").find((node) => text(node) === label)!;
const modal = () => view.root.findByType(ConfirmModal);
async function mount() {
  await act(async () => {
    view = create(
      <QueryClientProvider client={client}>
        <IntegrationConnectionsSettings workspaceId="selected-workspace" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
const click = async (node: ReactTestInstance) => {
  await act(async () => node.props.onClick());
};
beforeEach(() => {
  vi.resetAllMocks();
  __resetIntegrationConnectionMutationsForTests();
  items = [connection("one")];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  api.fetchIntegrationConnections.mockImplementation(async () => ({ items }));
  api.fetchIntegrationConnection.mockImplementation(async (id: string) =>
    items.find((item) => item.connectionId === id),
  );
  api.updateIntegrationConnection.mockImplementation(async (id: string, input: { enabled: boolean }) => {
    items = items.map((item) =>
      item.connectionId === id ? { ...item, enabled: input.enabled, revision: "b".repeat(64) } : item,
    );
    return items.find((item) => item.connectionId === id);
  });
});
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  client.clear();
  __resetIntegrationConnectionMutationsForTests();
});

describe("native integration connections", () => {
  it("shows global scope, saved status, and an explicit exact owner review before changing enabled state", async () => {
    await mount();
    expect(text(view.root)).toContain("across all workspaces");
    expect(button("Add and manage integrations").props["aria-expanded"]).toBe(false);
    expect(text(view.root)).toContain("Disabled · Paused");
    await click(button("Review enable"));
    expect(modal().props.open).toBe(true);
    expect(modal().props.message).toContain("Personal Citadel policy applies");
    expect(modal().props.message).not.toContain("a".repeat(64));
    expect(text(view.root.findByType("details"))).toContain("a".repeat(64));
    expect(modal().props.className).toContain("grid-cols-1");
    expect(modal().props.message).toContain("runtime synchronization");
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    await act(async () => modal().props.onConfirm());
    expect(api.updateIntegrationConnection).toHaveBeenCalledExactlyOnceWith("one", {
      expectedRevision: "a".repeat(64),
      enabled: true,
    });
    expect(text(view.root)).toContain("external connectivity has not been tested");
    expect(items[0]?.status).toBe("paused");
    expect(items[0]?.config).toEqual({ token: "[REDACTED]" });
  });
  it("excludes channels and catalog-only external connectors and bounds loaded rows", async () => {
    items = [
      ...Array.from({ length: 25 }, (_, index) => connection(String(index))),
      connection("channel", { kind: "channel" }),
      connection("catalog-only", { kind: "external_connector" }),
    ];
    await mount();
    expect(view.root.findAllByType("li")).toHaveLength(20);
    expect(text(view.root)).not.toContain("GitHub channel");
    expect(text(view.root)).not.toContain("GitHub catalog-only");
    await click(button("Show more integrations"));
    expect(view.root.findAllByType("li")).toHaveLength(25);
  });
  it("keeps unknown mutation outcomes visible and locked after a remount", async () => {
    await mount();
    await click(button("Review enable"));
    api.updateIntegrationConnection.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await act(async () => modal().props.onConfirm());
    await act(async () => view.unmount());
    await mount();
    expect(button("Review enable").props.disabled).toBe(true);
    expect(text(view.root)).toContain("outcome is unconfirmed");
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
  });
  it("withholds cached controls after a failed directory refresh", async () => {
    await mount();
    api.fetchIntegrationConnections.mockRejectedValueOnce(new Error("offline"));
    await click(button("Refresh integrations"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(text(view.root)).toContain("Integration directory unavailable");
    expect(view.root.findAllByType("li")).toHaveLength(0);
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
  });
});
