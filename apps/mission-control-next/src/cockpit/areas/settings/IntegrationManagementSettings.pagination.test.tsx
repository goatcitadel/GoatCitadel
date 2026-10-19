import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { IntegrationManagementSettings } from "./IntegrationManagementSettings";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";

const api = vi.hoisted(() => ({
  fetchIntegrationCatalog: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchSettings: vi.fn(),
  fetchGoogleMeetPrerequisiteStatus: vi.fn(),
  fetchGoogleMeetSessions: vi.fn(),
  startGoogleMeetSession: vi.fn(),
  createRealtimeVoiceClientSecret: vi.fn(),
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
let view: ReactTestRenderer;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  vi.unstubAllGlobals();
});

it("ST-21: keeps no second list or search, marks the open view pressed, and opens a connection the saved list selects", async () => {
  vi.clearAllMocks();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  __resetIntegrationConnectionMutationsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected external request");
    }),
  );
  const connections: IntegrationConnection[] = Array.from({ length: 25 }, (_, index) => ({
    connectionId: `connection-${index}`,
    revision: "a".repeat(64),
    catalogId: "productivity.fixture",
    key: "fixture",
    kind: "productivity",
    label: `Fixture ${index}`,
    enabled: false,
    status: "connected",
    config: {},
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
  }));
  api.fetchIntegrationCatalog.mockResolvedValue({ items: [] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: connections });
  api.fetchSettings.mockResolvedValue({ features: {} });
  api.fetchGoogleMeetPrerequisiteStatus.mockResolvedValue({ prerequisites: [] });
  api.fetchGoogleMeetSessions.mockResolvedValue([]);
  await act(async () => {
    view = create(<IntegrationManagementSettings workspaceId="fixture-workspace" />);
  });
  const click = async (label: string) => {
    const button = view.root.findAllByType("button").find((node) => text(node) === label);
    if (!button) throw new Error(`Missing ${label}`);
    await act(async () => button.props.onClick());
  };
  expect(view.root.findAllByType("li")).toHaveLength(0);
  expect(view.root.findAllByType("input").filter((node) => node.props.type === "search")).toHaveLength(0);
  expect(view.root.findAllByType("button").some((node) => text(node) === "Notification routing")).toBe(false);
  const views = view.root.findByProps({ role: "group", "aria-label": "Management views" });
  const pressed = () =>
    views
      .findAllByType("button")
      .filter((node) => node.props["aria-pressed"] === true)
      .map((node) => text(node));
  expect(pressed()).toEqual([]);
  await click("Google Meet preparation");
  expect(pressed()).toEqual(["Google Meet preparation"]);
  expect(api.fetchGoogleMeetSessions).toHaveBeenCalled();
  expect(view.root.findByProps({ "aria-label": "Google Meet URL" })).toBeDefined();
  await act(async () =>
    view.update(
      <IntegrationManagementSettings
        workspaceId="fixture-workspace"
        selection={{ connectionId: "connection-3", nonce: 1 }}
      />,
    ),
  );
  expect(pressed()).toEqual([]);
  expect(text(view.root)).toContain("Fixture 3");
  expect(api.startGoogleMeetSession).not.toHaveBeenCalled();
  expect(api.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
