// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChannelCapabilities, ChannelRuntimePolicy, ChannelSetupJourney } from "@goatcitadel/contracts";
import { ChannelJourneyEvidence } from "./ChannelJourneyEvidence";
const policy: ChannelRuntimePolicy = {
  pairing: true,
  allowlist: true,
  mentionGating: false,
  typing: false,
  activity: false,
  presence: false,
};
const capabilities: ChannelCapabilities = {
  platformUnsupportedActions: {},
  channelKey: "telegram",
  supportedActions: ["channel.send", "channel.reply"],
  supportedDeliveryActions: ["channel.send", "channel.reply"],
  supportedAttachmentSources: [],
  inboundModes: ["webhook"],
  threadCapabilities: { rooms: true, threads: true, replies: true, direct: true, groups: true },
  runtimePolicy: policy,
  activityCapabilities: { supported: false, phases: [], nativeEffects: [], clearOnTerminal: true, activityEmoji: {} },
  runtimePosture: {
    outboundTransport: "api",
    inboundTransport: "webhook",
    lifecycle: "stateless",
    inboundReadiness: "ready",
    operatorSummary: "A webhook bot with controlled sender access.",
  },
  chunkingMode: "fallback",
  supportsStreaming: false,
  supportNotes: [],
  setupDiagnostics: [],
  setupReady: true,
};
const fixture: ChannelSetupJourney = {
  connectionId: "telegram-fixture",
  connectionRevision: "current-revision",
  channelKey: "telegram",
  capabilities,
  runtime: {
    connectionId: "telegram-fixture",
    channelKey: "telegram",
    enabled: true,
    ready: true,
    inboundModes: ["webhook"],
    runtimePolicy: policy,
  },
  setupEvidence: [],
  states: {
    configuration: "verified",
    activation: "verified",
    outbound: "verified",
    inbound: "verified",
    reply: "verified",
  },
  latestInbound: {
    eventId: "new-event",
    status: "accepted",
    acceptedAt: "2026-10-09T03:00:00.000Z",
    sessionId: "session-new",
    turnId: "turn-new",
  },
  latestReply: { deliveryId: "new-failed-delivery", status: "failed", updatedAt: "2026-10-09T03:01:00.000Z" },
  latestReplyState: "failed",
};
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join(" ");
async function render(journey: ChannelSetupJourney) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ChannelJourneyEvidence journey={journey} />);
  });
  return renderer;
}
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
    const renderer = await render({
      ...fixture,
      latestReplyState: "unknown",
      latestReply: { ...fixture.latestReply!, status: "unknown" },
    });
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
    const renderer = await render({
      ...fixture,
      states: { ...fixture.states, reply: "unsupported" },
      latestReplyState: "unsupported",
      latestReply: undefined,
    });
    const latest = renderer.root.findByProps({ "aria-label": "Latest reply delivery" });
    expect(text(latest)).toContain("Not supported by this adapter");
    expect(text(latest)).toContain("Timestamp unavailable");
    expect(text(latest)).not.toContain("Failed");
    renderer.unmount();
  });
});
describe("connection diagnostics check names", () => {
  it("shows a stored `_sandbox_` check key as a test message, without changing the key", async () => {
    const diagnostics = {
      connectorType: "integration_connection" as const,
      connectorId: "telegram-fixture",
      status: "warn" as const,
      checkedAt: "2026-10-09T03:00:00.000Z",
      checks: [
        { key: "slack_sandbox_send", status: "fail" as const, message: "Test send: Default channel is missing." },
        { key: "ntfy_sandbox_cleanup", status: "warn" as const, message: "Test cleanup: not supported." },
      ],
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChannelJourneyEvidence diagnostics={diagnostics} />);
    });
    const copy = text(renderer.root);
    expect(copy).toContain("slack test send");
    expect(copy).toContain("ntfy test cleanup");
    expect(copy).not.toMatch(/sandbox/iu);
    expect(diagnostics.checks.map((check) => check.key)).toEqual(["slack_sandbox_send", "ntfy_sandbox_cleanup"]);
    renderer.unmount();
  });
  it("shows the stored `delivery_posture` key as sending and receiving, without changing the key", async () => {
    const diagnostics = {
      connectorType: "integration_connection" as const,
      connectorId: "matrix-fixture",
      status: "ok" as const,
      checkedAt: "2026-10-28T03:00:00.000Z",
      checks: [
        { key: "delivery_posture", status: "pass" as const, message: "Matrix outbound is text-only." },
        { key: "default_room", status: "pass" as const, message: "A default room is set." },
      ],
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChannelJourneyEvidence diagnostics={diagnostics} />);
    });
    const copy = text(renderer.root);
    expect(copy).toContain("how sending and receiving work");
    expect(copy).toContain("default room");
    expect(copy).not.toMatch(/posture/iu);
    expect(diagnostics.checks.map((check) => check.key)).toEqual(["delivery_posture", "default_room"]);
    renderer.unmount();
  });
});
describe("platform-unsupported actions", () => {
  it("lists actions the platform does not offer, with the reason", async () => {
    const renderer = await render({
      ...fixture,
      capabilities: {
        ...capabilities,
        platformUnsupportedActions: { "channel.typing": "Slack has no typing indicator for bot messages in channels." },
      },
    });
    const copy = text(renderer.root);
    expect(copy).toContain("Not offered by the platform:");
    expect(copy).toContain("typing (Slack has no typing indicator for bot messages in channels.)");
    renderer.unmount();
  });
  it("omits the line when the platform offers everything the adapter lists", async () => {
    const renderer = await render(fixture);
    expect(text(renderer.root)).not.toContain("Not offered by the platform");
    renderer.unmount();
  });
});
