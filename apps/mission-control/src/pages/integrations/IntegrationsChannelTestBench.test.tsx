import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
}));

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

vi.mock("../../components/ui", () => ({
  GCSelect: ({
    id,
    value,
    options,
    onChange,
  }: {
    id?: string;
    value?: string;
    options: Array<{ value: string; label: string }>;
    onChange?: (value: string) => void;
  }) => (
    <select
      id={id}
      value={value}
      onChange={(eventOrValue) =>
        onChange?.(typeof eventOrValue === "string" ? eventOrValue : eventOrValue.target.value)
      }
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { IntegrationsChannelTestBench, type IntegrationsChannelTestBenchProps } from "./IntegrationsChannelTestBench";

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => {
    const children = button.props.children;
    return Array.isArray(children) ? children.includes(label) : children === label;
  });
}

function buildProps(overrides: Partial<IntegrationsChannelTestBenchProps> = {}): IntegrationsChannelTestBenchProps {
  return {
    channelConnections: [],
    selectedChannelConnectionId: "",
    onSelectedChannelConnectionIdChange: vi.fn(),
    selectedChannelConnection: null,
    selectedChannelConnector: null,
    selectedChannelRuntimeStatus: undefined,
    selectedDiscordRuntime: undefined,
    selectedDiscordPairings: [],
    channelTestTarget: "",
    onChannelTestTargetChange: vi.fn(),
    channelTestBusy: false,
    onSendChannelTest: vi.fn(),
    onReconnectDiscordRuntime: vi.fn(),
    onApproveDiscordPairing: vi.fn(),
    onRevokeDiscordPairing: vi.fn(),
    discordPairingBusyId: null,
    channelTestMessage: "",
    onChannelTestMessageChange: vi.fn(),
    channelSubject: "",
    onChannelSubjectChange: vi.fn(),
    channelEffectId: "",
    onChannelEffectIdChange: vi.fn(),
    channelReplyToMessageId: "",
    onChannelReplyToMessageIdChange: vi.fn(),
    channelReplyToPartIndex: "",
    onChannelReplyToPartIndexChange: vi.fn(),
    channelAttachmentUrls: "",
    onChannelAttachmentUrlsChange: vi.fn(),
    channelAttachmentIdsText: "",
    onChannelAttachmentIdsTextChange: vi.fn(),
    channelUploadBusy: false,
    onUploadChannelAttachments: vi.fn(),
    uploadedChannelAttachments: [],
    onRemoveUploadedChannelAttachment: vi.fn(),
    channelTestResult: null,
    channelReactionMessageId: "",
    onChannelReactionMessageIdChange: vi.fn(),
    channelReactionEmoji: "",
    onChannelReactionEmojiChange: vi.fn(),
    channelActionBusy: null,
    onReactChannelTest: vi.fn(),
    channelUnsendMessageId: "",
    onChannelUnsendMessageIdChange: vi.fn(),
    onUnsendChannelTest: vi.fn(),
    channelActionResult: null,
    ...overrides,
  };
}

const discordConnection = {
  connectionId: "connection-discord",
  catalogId: "channel.discord",
  key: "discord",
  label: "Discord Ops",
  status: "connected",
  enabled: true,
  config: {
    runtimeMode: "gateway",
    defaultChannelId: "ops-channel",
  },
} as any;

const discordConnector = {
  connectorId: "connector-discord",
  label: "Discord",
  capabilities: [{ id: "approvals", enabled: true }],
  metadata: {
    channelCapabilities: {
      setupReady: false,
      supportedActions: ["channel.send", "channel.react", "channel.unsend"],
      supportedAttachmentSources: ["url", "upload"],
      supportNotes: ["Use approved Discord peers for operator approvals."],
      setupDiagnostics: ["Invite the bot before sending live messages."],
      runtimePosture: {
        operatorSummary: "Gateway bridge is available.",
      },
    },
  },
} as any;

describe("IntegrationsChannelTestBench", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an empty state when no channel connections exist", () => {
    const renderer = create(<IntegrationsChannelTestBench {...buildProps()} />);

    expect(rendererText(renderer)).toContain("No channel connections configured yet");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);

    renderer.unmount();
  });

  it("surfaces connector diagnostics and drives Discord/channel action callbacks", () => {
    const onSelectedChannelConnectionIdChange = vi.fn();
    const onChannelTestTargetChange = vi.fn();
    const onSendChannelTest = vi.fn();
    const onReconnectDiscordRuntime = vi.fn();
    const onApproveDiscordPairing = vi.fn();
    const onRevokeDiscordPairing = vi.fn();
    const onChannelTestMessageChange = vi.fn();
    const onChannelSubjectChange = vi.fn();
    const onChannelEffectIdChange = vi.fn();
    const onChannelReplyToMessageIdChange = vi.fn();
    const onChannelReplyToPartIndexChange = vi.fn();
    const onChannelAttachmentUrlsChange = vi.fn();
    const onChannelAttachmentIdsTextChange = vi.fn();
    const onUploadChannelAttachments = vi.fn();
    const onRemoveUploadedChannelAttachment = vi.fn();
    const onChannelReactionMessageIdChange = vi.fn();
    const onChannelReactionEmojiChange = vi.fn();
    const onReactChannelTest = vi.fn();
    const onChannelUnsendMessageIdChange = vi.fn();
    const onUnsendChannelTest = vi.fn();
    const files = { length: 1, item: () => null } as unknown as FileList;

    const renderer = create(
      <IntegrationsChannelTestBench
        {...buildProps({
          channelConnections: [discordConnection],
          selectedChannelConnectionId: "connection-discord",
          onSelectedChannelConnectionIdChange,
          selectedChannelConnection: discordConnection,
          selectedChannelConnector: discordConnector,
          selectedChannelRuntimeStatus: {
            ready: false,
            lastReadyAt: "2026-05-14T09:00:00.000Z",
            lastInboundAt: "2026-05-14T09:05:00.000Z",
            lastError: "Gateway token expired.",
            runtimePosture: { operatorSummary: "Runtime needs reconnect." },
          } as any,
          selectedDiscordRuntime: {
            ready: false,
            connectedBotTag: "goat#1234",
            guildIds: ["guild-1"],
            lastInboundAt: "2026-05-14T09:07:00.000Z",
            lastReconnectAt: "2026-05-14T09:01:00.000Z",
            lastError: "Socket closed.",
          } as any,
          selectedDiscordPairings: [
            {
              pairingId: "pairing-1",
              userId: "user-1",
              displayName: "Operator",
              status: "pending",
              code: "123456",
              lastInboundAt: "2026-05-14T09:08:00.000Z",
            } as any,
          ],
          channelTestTarget: "ops-channel",
          onChannelTestTargetChange,
          onSendChannelTest,
          channelTestMessage: "Ping from Mission Control",
          onChannelTestMessageChange,
          channelSubject: "Ops",
          onChannelSubjectChange,
          channelEffectId: "effect-1",
          onChannelEffectIdChange,
          channelReplyToMessageId: "message-1",
          onChannelReplyToMessageIdChange,
          channelReplyToPartIndex: "0",
          onChannelReplyToPartIndexChange,
          channelAttachmentUrls: "https://example.test/report.txt",
          onChannelAttachmentUrlsChange,
          channelAttachmentIdsText: "attachment-1",
          onChannelAttachmentIdsTextChange,
          onUploadChannelAttachments,
          uploadedChannelAttachments: [
            {
              attachmentId: "attachment-1",
              fileName: "report.txt",
              mimeType: "text/plain",
            } as any,
          ],
          onRemoveUploadedChannelAttachment,
          channelTestResult: "Message sent.",
          channelReactionMessageId: "message-1",
          onChannelReactionMessageIdChange,
          channelReactionEmoji: "thumbsup",
          onChannelReactionEmojiChange,
          onReactChannelTest,
          channelUnsendMessageId: "message-2",
          onChannelUnsendMessageIdChange,
          onUnsendChannelTest,
          channelActionResult: "Reaction sent.",
          onReconnectDiscordRuntime,
          onApproveDiscordPairing,
          onRevokeDiscordPairing,
        })}
      />,
    );

    const text = rendererText(renderer);
    expect(text).toContain("needs attention");
    expect(text).toContain("channel.send, channel.react, channel.unsend");
    expect(text).toContain("Runtime needs reconnect.");
    expect(text).toContain("Gateway token expired.");
    expect(text).toContain("goat#1234");
    expect(text).toContain("Operator");
    expect(text).toContain("Message sent.");
    expect(text).toContain("Reaction sent.");

    act(() => {
      renderer.root.findByProps({ id: "channelTestConnection" }).props.onChange("connection-other");
      renderer.root.findByProps({ id: "channelTestTarget" }).props.onChange({ target: { value: "alerts" } });
      renderer.root.findByProps({ id: "channelTestMessage" }).props.onChange({ target: { value: "Updated" } });
      renderer.root.findByProps({ id: "channelSubject" }).props.onChange({ target: { value: "Subject" } });
      renderer.root.findByProps({ id: "channelEffectId" }).props.onChange({ target: { value: "effect-2" } });
      renderer.root.findByProps({ id: "channelReplyToMessageId" }).props.onChange({
        target: { value: "message-3" },
      });
      renderer.root.findByProps({ id: "channelReplyToPartIndex" }).props.onChange({ target: { value: "1" } });
      renderer.root.findByProps({ id: "channelAttachmentUrls" }).props.onChange({
        target: { value: "https://example.test/next.txt" },
      });
      renderer.root.findByProps({ id: "channelAttachmentIdsText" }).props.onChange({
        target: { value: "attachment-2" },
      });
      renderer.root.findByProps({ id: "channelAttachmentUpload" }).props.onChange({
        target: { files },
        currentTarget: { value: "report.txt" },
      });
      renderer.root.findByProps({ id: "channelReactionMessageId" }).props.onChange({
        target: { value: "message-4" },
      });
      renderer.root.findByProps({ id: "channelReactionEmoji" }).props.onChange({ target: { value: "eyes" } });
      renderer.root.findByProps({ id: "channelUnsendMessageId" }).props.onChange({
        target: { value: "message-5" },
      });
    });

    expect(onSelectedChannelConnectionIdChange).toHaveBeenCalledWith("connection-other");
    expect(onChannelTestTargetChange).toHaveBeenCalledWith("alerts");
    expect(onChannelTestMessageChange).toHaveBeenCalledWith("Updated");
    expect(onChannelSubjectChange).toHaveBeenCalledWith("Subject");
    expect(onChannelEffectIdChange).toHaveBeenCalledWith("effect-2");
    expect(onChannelReplyToMessageIdChange).toHaveBeenCalledWith("message-3");
    expect(onChannelReplyToPartIndexChange).toHaveBeenCalledWith("1");
    expect(onChannelAttachmentUrlsChange).toHaveBeenCalledWith("https://example.test/next.txt");
    expect(onChannelAttachmentIdsTextChange).toHaveBeenCalledWith("attachment-2");
    expect(onUploadChannelAttachments).toHaveBeenCalledWith(files);
    expect(onChannelReactionMessageIdChange).toHaveBeenCalledWith("message-4");
    expect(onChannelReactionEmojiChange).toHaveBeenCalledWith("eyes");
    expect(onChannelUnsendMessageIdChange).toHaveBeenCalledWith("message-5");

    act(() => {
      findButton(renderer, "Send test")?.props.onClick();
      findButton(renderer, "Reconnect Discord runtime")?.props.onClick();
      findButton(renderer, "Approve")?.props.onClick();
      findButton(renderer, "Revoke")?.props.onClick();
      findButton(renderer, "Remove")?.props.onClick();
      findButton(renderer, "Send reaction")?.props.onClick();
      findButton(renderer, "Unsend message")?.props.onClick();
    });

    expect(onSendChannelTest).toHaveBeenCalledTimes(1);
    expect(onReconnectDiscordRuntime).toHaveBeenCalledWith("connection-discord");
    expect(onApproveDiscordPairing).toHaveBeenCalledWith("connection-discord", "pairing-1");
    expect(onRevokeDiscordPairing).toHaveBeenCalledWith("connection-discord", "pairing-1");
    expect(onRemoveUploadedChannelAttachment).toHaveBeenCalledWith("attachment-1");
    expect(onReactChannelTest).toHaveBeenCalledTimes(1);
    expect(onUnsendChannelTest).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
