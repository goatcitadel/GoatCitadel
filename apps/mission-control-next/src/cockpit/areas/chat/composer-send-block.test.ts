import { describe, expect, it } from "vitest";
import { WHATSAPP_REPLY_WINDOW_CLOSED } from "@goatcitadel/contracts";
import { committedCommandDraft, composerSendBlock } from "./composer-send-block";

type SendBlockProps = Parameters<typeof composerSendBlock>[0];

const help = { key: "help", command: "/help", description: "Show help", applyValue: "/help" };

function sendProps(overrides: Partial<SendBlockProps> = {}): SendBlockProps {
  return {
    draft: "",
    canSend: true,
    historicalReadOnly: false,
    sessionControlBanner: null,
    pendingApproval: null,
    pendingUserInput: null,
    pendingAttachments: [],
    runVariablePanel: undefined,
    composerPalette: undefined,
    routeBoundaryAckRequired: false,
    routeBoundaryAcknowledged: false,
    selectedSessionId: "session-1",
    profileDependentAdmissionBlockReason: null,
    routePreflight: null,
    routePreflightError: null,
    routePreflightLoading: false,
    providerOptions: [],
    selectedProviderId: undefined,
    selectedModel: undefined,
    commandSuggestions: [],
    ...overrides,
  } as SendBlockProps;
}

describe("committedCommandDraft", () => {
  it("is committed only when the first token exactly matches a suggestion", () => {
    expect(committedCommandDraft("/help", [help])).toBe(true);
    expect(committedCommandDraft("  /help", [help])).toBe(true);
    expect(committedCommandDraft("/help now", [help])).toBe(true);
    expect(committedCommandDraft("/help\nmore", [help])).toBe(true);
    expect(committedCommandDraft("/he", [help])).toBe(false);
    expect(committedCommandDraft("/helper", [help])).toBe(false);
    expect(committedCommandDraft("/help", [])).toBe(false);
    expect(committedCommandDraft("help", [{ ...help, applyValue: "help" }])).toBe(false);
  });

  it("compares against the trimmed apply value the palette inserts", () => {
    expect(committedCommandDraft("/help", [{ ...help, applyValue: "/help " }])).toBe(true);
  });

  it("never treats context or skill tokens as committed", () => {
    expect(committedCommandDraft("$skill", [{ ...help, applyValue: "$skill" }])).toBe(false);
    expect(committedCommandDraft("@file", [{ ...help, applyValue: "@file" }])).toBe(false);
  });
});

describe("composerSendBlock with command suggestions", () => {
  it("blocks a partial command while suggestions are open", () => {
    expect(composerSendBlock(sendProps({ draft: "/he", commandSuggestions: [help] }))).toEqual({
      kind: "blocked",
      message: "Choose a suggestion before sending.",
    });
    expect(composerSendBlock(sendProps({ draft: "/helper", commandSuggestions: [help] }))?.kind).toBe("blocked");
  });

  it("lets a committed command send even though its suggestion is still listed", () => {
    expect(composerSendBlock(sendProps({ draft: "/help", commandSuggestions: [help] }))).toBeNull();
    expect(composerSendBlock(sendProps({ draft: "/help now", commandSuggestions: [help] }))).toBeNull();
  });

  it("keeps blocking context and skill tokens until a suggestion is chosen", () => {
    expect(
      composerSendBlock(sendProps({ draft: "$skill", commandSuggestions: [{ ...help, applyValue: "$skill" }] }))?.kind,
    ).toBe("blocked");
  });
});

describe("composerSendBlock in a channel conversation", () => {
  const reply = (status: "on" | "off" | "needs_attention" | "removed") => ({
    mode: "post" as const,
    channelLabel: "Telegram",
    targetTitle: "Maya",
    status,
  });

  it("blocks replies in a removed channel's conversation", () => {
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: reply("removed") }))).toEqual({
      kind: "channel-removed",
      message: "This channel was removed. Its conversations stay readable.",
    });
  });

  it("blocks replies while the channel is off", () => {
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: reply("off") }))).toEqual({
      kind: "channel-off",
      message: "Turn Telegram back on to reply.",
    });
  });

  it("blocks a WhatsApp reply outside the 24-hour window, behind a removed or off channel's own reason", () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const windowed = (status: "on" | "off" | "removed", hours: number) => ({
      ...reply(status),
      channelLabel: "WhatsApp",
      replyWindow: { channelKey: "whatsapp", lastInboundAt: hoursAgo(hours) },
    });
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: windowed("on", 25) }))).toEqual({
      kind: "reply-window-closed",
      message: WHATSAPP_REPLY_WINDOW_CLOSED,
    });
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: windowed("on", 1) }))).toBeNull();
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: windowed("off", 25) }))?.kind).toBe(
      "channel-off",
    );
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: windowed("removed", 25) }))?.kind).toBe(
      "channel-removed",
    );
    // The read-only earlier version still comes first.
    expect(composerSendBlock(sendProps({ historicalReadOnly: true, channelReply: windowed("on", 25) }))?.kind).toBe(
      "historical",
    );
  });

  it("leaves a channel that is on or needs attention sendable", () => {
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: reply("on") }))).toBeNull();
    expect(composerSendBlock(sendProps({ draft: "Hello", channelReply: reply("needs_attention") }))).toBeNull();
  });

  it("still shows the read-only earlier version first", () => {
    expect(composerSendBlock(sendProps({ historicalReadOnly: true, channelReply: reply("removed") }))?.kind).toBe(
      "historical",
    );
  });

  it("does not send while the channel is still being checked", () => {
    expect(composerSendBlock(sendProps({ draft: "Hello", channelCheck: "checking" }))).toEqual({
      kind: "channel-checking",
      message: "Checking this channel…",
    });
  });

  it("does not send when the channel could not be checked", () => {
    expect(composerSendBlock(sendProps({ draft: "Hello", channelCheck: "unavailable" }))).toEqual({
      kind: "channel-unavailable",
      message: "Couldn't check this channel. Try again from Messaging.",
    });
  });

  it("does not send files in a channel conversation, alone or with a message", () => {
    const files = [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }];
    const message = "Files aren't sent in channel conversations. Remove them to send.";
    expect(composerSendBlock(sendProps({ draft: "", pendingAttachments: files, channelReply: reply("on") }))).toEqual({
      kind: "blocked",
      message,
    });
    expect(
      composerSendBlock(sendProps({ draft: "Hello", pendingAttachments: files, channelReply: reply("on") })),
    ).toEqual({ kind: "blocked", message });
    expect(composerSendBlock(sendProps({ draft: "", pendingAttachments: files }))).toBeNull();
  });
});
