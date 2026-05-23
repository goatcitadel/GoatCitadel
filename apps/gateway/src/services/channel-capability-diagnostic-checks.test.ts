import { describe, expect, it } from "vitest";
import type { ChannelCapabilities } from "@goatcitadel/contracts";
import { buildChannelCapabilityDiagnosticChecks } from "./channel-capability-diagnostic-checks.js";

describe("buildChannelCapabilityDiagnosticChecks", () => {
  it("reports outbound-only channels explicitly", () => {
    const checks = buildChannelCapabilityDiagnosticChecks(
      createCapabilities({
        inboundModes: ["none"],
      }),
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        {
          key: "inbound_mode",
          status: "pass",
          message: "Inbound mode: none (outbound-only connection).",
        },
        {
          key: "runtime_posture",
          status: "warn",
          message:
            "Runtime posture: Outbound-only webhook delivery; no inbound runtime or pairing session is available.",
        },
        {
          key: "runtime_policy",
          status: "pass",
          message: "Runtime policy gates: none.",
        },
        {
          key: "setup_ready",
          status: "pass",
          message: "Setup posture: ready.",
        },
      ]),
    );
  });

  it("reports gateway inbound modes and enabled runtime policy flags", () => {
    const checks = buildChannelCapabilityDiagnosticChecks(
      createCapabilities({
        inboundModes: ["gateway"],
        runtimePolicy: {
          pairing: true,
          allowlist: true,
          mentionGating: true,
          typing: true,
          activity: true,
          presence: true,
        },
        runtimePosture: {
          outboundTransport: "api",
          inboundTransport: "gateway",
          lifecycle: "persistent",
          inboundReadiness: "ready",
          operatorSummary:
            "Persistent gateway runtime keeps Discord inbound messages, typing, and presence synchronized in-process.",
        },
      }),
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        {
          key: "inbound_mode",
          status: "pass",
          message: "Inbound modes: gateway.",
        },
        {
          key: "runtime_posture",
          status: "pass",
          message:
            "Runtime posture: Persistent gateway runtime keeps Discord inbound messages, typing, and presence synchronized in-process.",
        },
        {
          key: "runtime_policy",
          status: "pass",
          message: "Runtime policy gates: activity, allowlist, mentionGating, pairing, presence, typing.",
        },
        {
          key: "setup_ready",
          status: "pass",
          message: "Setup posture: ready.",
        },
      ]),
    );
  });

  it("surfaces setup follow-up diagnostics and support notes", () => {
    const checks = buildChannelCapabilityDiagnosticChecks(
      createCapabilities({
        setupReady: false,
        setupDiagnostics: ["Missing sandbox channel.", "Webhook test not yet completed."],
        supportNotes: ["Gateway mode supports richer inbound routing than webhook fallback."],
      }),
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        {
          key: "setup_ready",
          status: "warn",
          message: "Setup posture: follow-up required (2 diagnostic items).",
        },
        {
          key: "setup_diagnostics",
          status: "warn",
          message: "Setup diagnostics: Missing sandbox channel. Webhook test not yet completed.",
        },
        {
          key: "support_notes",
          status: "pass",
          message: "Support notes: Gateway mode supports richer inbound routing than webhook fallback.",
        },
      ]),
    );
  });
});

function createCapabilities(overrides?: Partial<ChannelCapabilities>): ChannelCapabilities {
  return {
    channelKey: "discord",
    supportedActions: ["channel.send"],
    supportedDeliveryActions: ["channel.send"],
    supportedAttachmentSources: [],
    inboundModes: ["none"],
    threadCapabilities: {
      rooms: false,
      threads: false,
      replies: false,
      direct: false,
      groups: false,
    },
    runtimePolicy: {
      pairing: false,
      allowlist: false,
      mentionGating: false,
      typing: false,
      activity: false,
      presence: false,
    },
    activityCapabilities: {
      supported: true,
      phases: ["seen", "thinking", "tooling", "waiting_approval", "failed", "clear"],
      nativeEffects: ["mission_control"],
      clearOnTerminal: true,
      activityEmoji: { seen: "👀" },
    },
    runtimePosture: {
      outboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
      operatorSummary: "Outbound-only webhook delivery; no inbound runtime or pairing session is available.",
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    supportNotes: [],
    setupDiagnostics: [],
    setupReady: true,
    ...overrides,
  };
}
