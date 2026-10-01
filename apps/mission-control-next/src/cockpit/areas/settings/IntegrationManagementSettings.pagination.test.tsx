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
let view: ReactTestRenderer;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  vi.unstubAllGlobals();
});

it("keeps the selected Meet owner visible and its input intact while the connection list is paged and filtered", async () => {
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
  expect(view.root.findAllByType("li")).toHaveLength(20);
  await click("Google Meet preparation");
  expect(api.fetchGoogleMeetSessions).toHaveBeenCalled();
  const meetingInput = () => view.root.findByProps({ "aria-label": "Google Meet URL" });
  expect(meetingInput()).toBeDefined();
  await act(async () =>
    meetingInput().props.onChange({ target: { value: "https://meet.google.com/fixture-meeting" } }),
  );
  await click("Show more managed integrations");
  expect(view.root.findAllByType("li")).toHaveLength(25);
  expect(meetingInput().props.value).toBe("https://meet.google.com/fixture-meeting");
  await act(async () =>
    view.root
      .findByProps({ "aria-label": "Find managed integration" })
      .props.onChange({ target: { value: "no matches" } }),
  );
  expect(view.root.findAllByType("li")).toHaveLength(0);
  expect(meetingInput().props.value).toBe("https://meet.google.com/fixture-meeting");
  expect(api.startGoogleMeetSession).not.toHaveBeenCalled();
  expect(api.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
