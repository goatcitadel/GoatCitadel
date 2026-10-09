// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelCapabilities, ChannelRuntimePolicy, ChannelSetupJourney, ConnectorDiagnosticReport, IntegrationConnection } from "@goatcitadel/contracts";
import { useChannelSetupState, type ChannelSetupState } from "../sections/use-channel-setup-state";
import { ChannelJourneyPanel } from "./ChannelJourneyPanel";
import { ChannelOperations } from "../../../../cockpit/areas/settings/ChannelOperations";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetChannelMutationStateForTests } from "../sections/channel-setup-state";

const api = vi.hoisted(() => ({ fetchChannelSetupDefinitions: vi.fn(), fetchChannelSetupDrafts: vi.fn(), fetchIntegrationConnections: vi.fn(), fetchIntegrationConnection: vi.fn(), fetchSettings: vi.fn(), fetchAgenticChannelDeliveries: vi.fn(), fetchChannelDiagnostics: vi.fn() }));
const operations = vi.hoisted(() => ({ fetchChannelSetupJourney: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", () => operations);
// These adapter-specific controls are outside the diagnostics/read-only journey seam.
vi.mock("./use-discord-operations", () => ({ useDiscordOperations: () => ({ selectedConnection: undefined }) }));
vi.mock("./TelegramPairingPanel", () => ({ TelegramPairingPanel: () => null }));
vi.mock("../../../../cockpit/ui/Dialog", () => ({ Dialog: () => null }));

const observedAt = "2026-10-09T04:00:00.000Z";
const connection: IntegrationConnection = { connectionId: "ntfy-diagnostics-fixture", revision: "current-revision", catalogId: "channel.ntfy", kind: "channel", key: "ntfy", label: "Notification fixture", enabled: true, status: "connected", config: {}, createdAt: observedAt, updatedAt: observedAt };
const policy: ChannelRuntimePolicy = { pairing: false, allowlist: false, mentionGating: false, typing: false, activity: false, presence: false };
const capabilities: ChannelCapabilities = {
  channelKey: "ntfy", supportedActions: ["channel.send"], supportedDeliveryActions: ["channel.send"], supportedAttachmentSources: [], inboundModes: [],
  threadCapabilities: { rooms: false, threads: false, replies: false, direct: false, groups: false }, runtimePolicy: policy,
  activityCapabilities: { supported: false, phases: [], nativeEffects: [], clearOnTerminal: true, activityEmoji: {} },
  runtimePosture: { outboundTransport: "api", lifecycle: "stateless", inboundReadiness: "unsupported", operatorSummary: "Notification fixture journey remains visible." },
  chunkingMode: "fallback", supportsStreaming: false, supportNotes: [], setupDiagnostics: [], setupReady: true,
};
const journey: ChannelSetupJourney = { connectionId: connection.connectionId, connectionRevision: connection.revision, channelKey: "ntfy", capabilities,
  runtime: { connectionId: connection.connectionId, channelKey: "ntfy", enabled: true, ready: true, inboundModes: [], runtimePolicy: policy }, setupEvidence: [],
  states: { configuration: "verified", activation: "verified", outbound: "verified", inbound: "unsupported", reply: "unsupported" }, latestReplyState: "unsupported" };
const diagnostics: ConnectorDiagnosticReport = { connectorType: "integration_connection", connectorId: connection.connectionId, status: "ok", checkedAt: observedAt, checks: [{ key: "current_transport", status: "pass", message: "Current transport fixture verified." }] };
const delivery = { deliveryId: "delivery-fixture", connectionId: connection.connectionId, channelKey: "ntfy", target: "fixture-topic", status: "sent", attempts: 1, maxAttempts: 1, providerMessageId: "synthetic-receipt", createdAt: observedAt, updatedAt: observedAt };
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join(" ");
let owner!: ChannelSetupState;
let renderer: ReactTestRenderer | undefined;
function Harness({ shell }: { shell: "classic" | "cockpit" }) {
  owner = useChannelSetupState("diagnostics-feature-fixture");
  return owner.data ? shell === "classic"
    ? <ChannelJourneyPanel connections={owner.data.connections} connectorDiagnosticsEnabled={owner.data.connectorDiagnosticsEnabled} />
    : <ChannelOperations connection={owner.data.connections[0]!} connectorDiagnosticsEnabled={owner.data.connectorDiagnosticsEnabled} />
    : <p>Loading Channels snapshot</p>;
}
async function render(shell: "classic" | "cockpit") {
  await act(async () => { renderer = create(<Harness shell={shell} />); });
  for(let i=0;i<4;i++) await act(async () => { await Promise.resolve(); });
  return renderer!;
}
beforeEach(() => {
  vi.resetAllMocks(); __resetSessionViewStateForTests(); __resetSessionDraftsForTests(); __resetChannelMutationStateForTests();
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [] }); api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] }); api.fetchIntegrationConnections.mockResolvedValue({ items: [connection] });
  api.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: false } });
  api.fetchAgenticChannelDeliveries.mockResolvedValue({ deliveries: [delivery], count: 1 }); operations.fetchChannelSetupJourney.mockResolvedValue(journey); api.fetchChannelDiagnostics.mockResolvedValue(diagnostics);
});
afterEach(async () => { if(renderer) await act(async () => { renderer?.unmount(); }); renderer=undefined; });
describe("feature-aware channel diagnostics", () => {
  for(const shell of ["classic", "cockpit"] as const) {
    it(shell+" skips disabled diagnostics without hiding journey or delivery evidence", async () => {
      const view=await render(shell);
      expect(api.fetchSettings).toHaveBeenCalledTimes(1);
      expect(api.fetchChannelDiagnostics).not.toHaveBeenCalled();
      expect(operations.fetchChannelSetupJourney).toHaveBeenCalledWith(connection.connectionId);
      expect(api.fetchAgenticChannelDeliveries).toHaveBeenCalledWith({ connectionId: connection.connectionId, limit: 10 });
      expect(text(view.root)).toContain("Diagnostics are disabled in runtime settings.");
      expect(text(view.root)).toContain(capabilities.runtimePosture.operatorSummary);
      expect(text(view.root)).toContain("provider receipt recorded");
      expect(text(view.root)).not.toContain("Diagnostics could not be loaded.");
    });
    it(shell+" reads and renders exact diagnostics when the canonical runtime setting is enabled", async () => {
      api.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: true } });
      const view=await render(shell);
      expect(api.fetchChannelDiagnostics).toHaveBeenCalledTimes(1);
      expect(api.fetchChannelDiagnostics).toHaveBeenCalledWith(connection.connectionId);
      expect(text(view.root)).toContain("Current transport fixture verified.");
      expect(text(view.root)).not.toContain("Diagnostics are disabled");
    });
  }
  it("does not guess feature availability when the settings read fails", async () => {
    api.fetchSettings.mockRejectedValue(new Error("Settings fixture unavailable"));
    const view=await render("cockpit");
    expect(api.fetchChannelDiagnostics).not.toHaveBeenCalled();
    expect(text(view.root)).toContain("Diagnostics are unavailable because their runtime setting could not be verified.");
    expect(text(view.root)).toContain(capabilities.runtimePosture.operatorSummary);
    expect(text(view.root)).toContain("provider receipt recorded");
    expect(owner.data?.issues).toEqual([expect.objectContaining({ label: "Runtime settings" })]);
  });
  it("does not guess feature availability when the setting is absent", async () => {
    api.fetchSettings.mockResolvedValue({ features: {} });
    const view=await render("classic");
    expect(api.fetchChannelDiagnostics).not.toHaveBeenCalled();
    expect(text(view.root)).toContain("runtime setting could not be verified");
    expect(owner.data?.issues).toEqual([]);
  });
  it("drops an in-flight diagnostic report when refreshed runtime settings disable it", async () => {
    api.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: true } });
    let complete!: (value: ConnectorDiagnosticReport) => void;
    api.fetchChannelDiagnostics.mockReturnValue(new Promise<ConnectorDiagnosticReport>((resolve) => { complete=resolve; }));
    const view=await render("cockpit");
    api.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: false } });
    await act(async () => { await owner.reload(); });
    for(let i=0;i<4;i++) await act(async () => { await Promise.resolve(); });
    expect(text(view.root)).toContain("Diagnostics are disabled in runtime settings.");
    await act(async () => { complete(diagnostics); });
    expect(api.fetchChannelDiagnostics).toHaveBeenCalledTimes(1);
    expect(text(view.root)).not.toContain("Current transport fixture verified.");
    expect(text(view.root)).toContain("provider receipt recorded");
  });
  it("contains an enabled diagnostics error while retaining the other exact evidence", async () => {
    api.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: true } });
    api.fetchChannelDiagnostics.mockRejectedValue(new Error("Diagnostic fixture unavailable"));
    const view=await render("cockpit");
    expect(text(view.root)).toContain("Diagnostics could not be loaded.");
    expect(text(view.root)).toContain(capabilities.runtimePosture.operatorSummary);
    expect(text(view.root)).toContain("provider receipt recorded");
  });
});
