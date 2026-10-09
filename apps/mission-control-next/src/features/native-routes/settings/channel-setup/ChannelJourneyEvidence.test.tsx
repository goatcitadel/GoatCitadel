// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChannelCapabilities, ChannelRuntimePolicy, ChannelSetupJourney } from "@goatcitadel/contracts";
import { ChannelJourneyEvidence } from "./ChannelJourneyEvidence";
const policy: ChannelRuntimePolicy = { pairing: true, allowlist: true, mentionGating: false, typing: false, activity: false, presence: false };
const capabilities: ChannelCapabilities = {
  channelKey: "telegram", supportedActions: ["channel.send", "channel.reply"], supportedDeliveryActions: ["channel.send", "channel.reply"], supportedAttachmentSources: [], inboundModes: ["webhook"],
  threadCapabilities: { rooms: true, threads: true, replies: true, direct: true, groups: true }, runtimePolicy: policy,
  activityCapabilities: { supported: false, phases: [], nativeEffects: [], clearOnTerminal: true, activityEmoji: {} },
  runtimePosture: { outboundTransport: "api", inboundTransport: "webhook", lifecycle: "stateless", inboundReadiness: "ready", operatorSummary: "A webhook bot with controlled sender access." },
  chunkingMode: "fallback", supportsStreaming: false, supportNotes: [], setupDiagnostics: [], setupReady: true,
};
const fixture: ChannelSetupJourney = {
  connectionId: "telegram-fixture", connectionRevision: "current-revision", channelKey: "telegram", capabilities,
  runtime: { connectionId: "telegram-fixture", channelKey: "telegram", enabled: true, ready: true, inboundModes: ["webhook"], runtimePolicy: policy },
  setupEvidence: [], states: { configuration: "verified", activation: "verified", outbound: "verified", inbound: "verified", reply: "verified" },
  latestInbound: { eventId: "new-event", status: "accepted", acceptedAt: "2026-10-09T03:00:00.000Z", sessionId: "session-new", turnId: "turn-new" },
  latestReply: { deliveryId: "new-failed-delivery", status: "failed", updatedAt: "2026-10-09T03:01:00.000Z" }, latestReplyState: "failed",
};
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join(" ");
async function render(journey: ChannelSetupJourney) { let renderer!: ReactTestRenderer; await act(async () => { renderer = create(<ChannelJourneyEvidence journey={journey} />); }); return renderer; }
describe("current reply delivery evidence", () => {
  it("retains verified first-reply proof while exposing a newer failed delivery and its timestamp", async () => {
    const latestWithPrivateBody = { ...fixture.latestReply!, body: "PRIVATE_REPLY_FIXTURE_DO_NOT_RENDER" };
    const renderer = await render({ ...fixture, latestReply: latestWithPrivateBody });
    const firstReply = renderer.root.findAllByType("li").find((item) => text(item).includes("First reply receipt"))!;
    expect(text(firstReply)).toContain("Verified");
    const latest = renderer.root.findByProps({ "aria-label": "Latest reply delivery" });
    expect(text(latest)).toContain("Failed");
    expect(text(latest)).toContain(new Date(fixture.latestReply!.updatedAt).toLocaleString());
    expect(latest.findByProps({ role: "alert" })).toBeDefined();
    expect(text(renderer.root)).not.toContain("PRIVATE_REPLY_FIXTURE_DO_NOT_RENDER");
    renderer.unmount();
  });
  it("shows an uncertain latest result even when the first successful receipt remains verified", async () => {
    const renderer = await render({ ...fixture, latestReplyState: "unknown", latestReply: { ...fixture.latestReply!, status: "unknown" } });
    const latest = renderer.root.findByProps({ "aria-label": "Latest reply delivery" });
    expect(text(latest)).toContain("Outcome uncertain");
    expect(text(latest)).not.toContain("Not observed");
    expect(text(latest)).not.toContain("Verified");
    renderer.unmount();
  });
  it("does not use historical success as a fallback for an absent latest state", async () => {
    const renderer = await render({ ...fixture, latestReplyState: undefined });
    expect(text(renderer.root.findByProps({ "aria-label": "Latest reply delivery" }))).toContain("Outcome uncertain");
    renderer.unmount();
  });
  it("keeps outbound-only adapters' reply limitations explicit", async () => {
    const renderer = await render({ ...fixture, states: { ...fixture.states, reply: "unsupported" }, latestReplyState: "unsupported", latestReply: undefined });
    const latest = renderer.root.findByProps({ "aria-label": "Latest reply delivery" });
    expect(text(latest)).toContain("Not supported by this adapter");
    expect(text(latest)).toContain("Timestamp unavailable");
    expect(text(latest)).not.toContain("Failed");
    renderer.unmount();
  });
});
