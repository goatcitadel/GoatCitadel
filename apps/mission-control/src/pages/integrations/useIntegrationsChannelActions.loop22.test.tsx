import type { ChatAttachmentRecord, ConnectorRecord } from "@goatcitadel/contracts";
import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "../../api/client";
import { useIntegrationsChannelActions } from "./useIntegrationsChannelActions";

const apiMocks = vi.hoisted(() => ({
  commsReact: vi.fn(),
  commsSend: vi.fn(),
  commsUnsend: vi.fn(),
  uploadChatAttachment: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  commsReact: apiMocks.commsReact,
  commsSend: apiMocks.commsSend,
  commsUnsend: apiMocks.commsUnsend,
  uploadChatAttachment: apiMocks.uploadChatAttachment,
}));

type Actions = ReturnType<typeof useIntegrationsChannelActions>;

let latestActions: Actions | null = null;
let latestState: {
  error: string | null;
  channelTestBusy: boolean;
  channelTestResult: string | null;
  channelActionBusy: "react" | "unsend" | null;
  channelActionResult: string | null;
  channelUploadBusy: boolean;
  uploadedChannelAttachments: ChatAttachmentRecord[];
} | null = null;

function attachment(attachmentId: string, name = `${attachmentId}.txt`): ChatAttachmentRecord {
  return {
    attachmentId,
    sessionId: "integrations-upload",
    fileName: name,
    mimeType: "text/plain",
    sizeBytes: 10,
    sha256: `sha-${attachmentId}`,
    storageRelPath: `attachments/${attachmentId}`,
    extractStatus: "ready",
    createdAt: "2026-05-14T12:00:00.000Z",
  };
}

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    catalogId: "discord",
    kind: "channel",
    key: "discord",
    label: "Discord",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-14T12:00:00.000Z",
    ...overrides,
  } as IntegrationConnection;
}

function connector(supportedActions: string[] = ["channel.react", "channel.unsend"]): ConnectorRecord {
  return {
    connectorId: "connector-1",
    connectorType: "integration_connection",
    label: "Discord connector",
    sourceId: "conn-1",
    status: "active",
    capabilities: [],
    metadata: {
      channelCapabilities: {
        supportedActions,
      },
    },
  };
}

function Harness(props: {
  selectedChannelConnection?: IntegrationConnection | null;
  selectedChannelConnector?: ConnectorRecord | null;
  channelTestTarget?: string;
  channelTestMessage?: string;
  channelAttachmentUrls?: string;
  channelAttachmentIdsText?: string;
  uploadedChannelAttachments?: ChatAttachmentRecord[];
  channelReplyToMessageId?: string;
  channelReplyToPartIndex?: string;
  channelEffectId?: string;
  channelSubject?: string;
  channelReactionMessageId?: string;
  channelReactionEmoji?: string;
  channelUnsendMessageId?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [channelTestBusy, setChannelTestBusy] = useState(false);
  const [channelTestResult, setChannelTestResult] = useState<string | null>(null);
  const [channelActionBusy, setChannelActionBusy] = useState<"react" | "unsend" | null>(null);
  const [channelActionResult, setChannelActionResult] = useState<string | null>(null);
  const [channelUploadBusy, setChannelUploadBusy] = useState(false);
  const [uploadedChannelAttachments, setUploadedChannelAttachments] = useState<ChatAttachmentRecord[]>(
    props.uploadedChannelAttachments ?? [],
  );

  latestActions = useIntegrationsChannelActions({
    selectedChannelConnection:
      "selectedChannelConnection" in props ? (props.selectedChannelConnection ?? null) : connection(),
    selectedChannelConnector:
      "selectedChannelConnector" in props ? (props.selectedChannelConnector ?? null) : connector(),
    channelTestTarget: props.channelTestTarget ?? "room-1",
    channelTestMessage: props.channelTestMessage ?? "hello from ops",
    channelAttachmentUrls: props.channelAttachmentUrls ?? "",
    channelAttachmentIdsText: props.channelAttachmentIdsText ?? "",
    uploadedChannelAttachments,
    channelReplyToMessageId: props.channelReplyToMessageId ?? "",
    channelReplyToPartIndex: props.channelReplyToPartIndex ?? "",
    channelEffectId: props.channelEffectId ?? "",
    channelSubject: props.channelSubject ?? "",
    channelReactionMessageId: props.channelReactionMessageId ?? "provider-1",
    channelReactionEmoji: props.channelReactionEmoji ?? "+1",
    channelUnsendMessageId: props.channelUnsendMessageId ?? "provider-1",
    setError,
    setChannelTestBusy,
    setChannelTestResult,
    setChannelActionBusy,
    setChannelActionResult,
    setChannelUploadBusy,
    setUploadedChannelAttachments,
  });

  latestState = {
    error,
    channelTestBusy,
    channelTestResult,
    channelActionBusy,
    channelActionResult,
    channelUploadBusy,
    uploadedChannelAttachments,
  };

  return null;
}

async function renderHarness(element: React.ReactElement): Promise<Actions> {
  await act(async () => {
    create(element);
  });
  expect(latestActions).toBeTruthy();
  return latestActions!;
}

describe("useIntegrationsChannelActions", () => {
  beforeEach(() => {
    latestActions = null;
    latestState = null;
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
  });

  it("validates channel send preconditions before calling the gateway", async () => {
    let actions = await renderHarness(<Harness selectedChannelConnection={null} />);
    await act(async () => {
      await actions.onSendChannelTest();
    });
    expect(latestState?.error).toBe("Choose a channel connection first.");

    actions = await renderHarness(<Harness channelTestMessage="   " />);
    await act(async () => {
      await actions.onSendChannelTest();
    });
    expect(latestState?.error).toBe("Enter a test message.");

    actions = await renderHarness(<Harness channelTestTarget=" " />);
    await act(async () => {
      await actions.onSendChannelTest();
    });
    expect(latestState?.error).toBe("Enter a destination target or configure a default one.");
    expect(apiMocks.commsSend).not.toHaveBeenCalled();
  });

  it("sends channel tests with normalized attachments and optional delivery metadata", async () => {
    apiMocks.commsSend.mockResolvedValueOnce({ status: "queued", providerMessageId: "provider-99" });
    const actions = await renderHarness(
      <Harness
        channelAttachmentIdsText={"existing\nmanual-1\nexisting"}
        channelAttachmentUrls={"https://files.example/one.txt\n\nhttps://files.example/two.txt"}
        channelEffectId="  confetti "
        channelReplyToMessageId=" thread-root "
        channelReplyToPartIndex=" 2 "
        channelSubject=" Release desk "
        uploadedChannelAttachments={[attachment("existing"), attachment("uploaded-1")]}
      />,
    );

    await act(async () => {
      await actions.onSendChannelTest();
    });

    expect(apiMocks.commsSend).toHaveBeenCalledWith({
      connectionId: "conn-1",
      target: "room-1",
      message: "hello from ops",
      attachments: [{ url: "https://files.example/one.txt" }, { url: "https://files.example/two.txt" }],
      attachmentIds: ["existing", "manual-1", "uploaded-1"],
      replyToMessageId: "thread-root",
      replyToPartIndex: 2,
      effectId: "confetti",
      subject: "Release desk",
    });
    expect(latestState?.channelTestBusy).toBe(false);
    expect(latestState?.channelTestResult).toBe("Delivered with status queued. Provider message id: provider-99.");
    expect(latestState?.error).toBeNull();
  });

  it("handles react and unsend capability checks, validation, success, and gateway errors", async () => {
    let actions = await renderHarness(<Harness selectedChannelConnector={connector([])} />);
    await act(async () => {
      await actions.onReactChannelTest();
    });
    expect(latestState?.error).toBe("This channel connection does not support reactions.");

    actions = await renderHarness(<Harness channelReactionEmoji=" " />);
    await act(async () => {
      await actions.onReactChannelTest();
    });
    expect(latestState?.error).toBe("Enter a reaction emoji.");

    apiMocks.commsReact.mockResolvedValueOnce({});
    actions = await renderHarness(<Harness channelReactionEmoji="🔥" channelReactionMessageId=" provider-2 " />);
    await act(async () => {
      await actions.onReactChannelTest();
    });
    expect(apiMocks.commsReact).toHaveBeenCalledWith({
      connectionId: "conn-1",
      target: "room-1",
      messageId: "provider-2",
      reaction: "🔥",
    });
    expect(latestState?.channelActionResult).toBe("Reaction request completed with status reacted.");

    apiMocks.commsUnsend.mockRejectedValueOnce(new Error("provider refused unsend"));
    actions = await renderHarness(<Harness channelUnsendMessageId=" provider-3 " />);
    await act(async () => {
      await actions.onUnsendChannelTest();
    });
    expect(latestState?.error).toBe("provider refused unsend");
    expect(latestState?.channelActionBusy).toBeNull();

    apiMocks.commsUnsend.mockResolvedValueOnce({ status: "removed" });
    await act(async () => {
      await actions.onUnsendChannelTest();
    });
    expect(latestState?.channelActionResult).toBe("Unsend request completed with status removed.");
    expect(latestState?.error).toBeNull();
  });

  it("uploads, dedupes, and removes channel attachments", async () => {
    apiMocks.uploadChatAttachment
      .mockResolvedValueOnce(attachment("existing", "duplicate.txt"))
      .mockResolvedValueOnce(attachment("fresh", "fresh.txt"));
    const actions = await renderHarness(<Harness uploadedChannelAttachments={[attachment("existing")]} />);
    const files = [{ name: "duplicate.txt" }, { name: "fresh.txt" }] as unknown as FileList;

    await act(async () => {
      await actions.onUploadChannelAttachments(files);
    });

    expect(apiMocks.uploadChatAttachment).toHaveBeenCalledTimes(2);
    expect(latestState?.uploadedChannelAttachments.map((item) => item.attachmentId)).toEqual(["existing", "fresh"]);
    expect(latestState?.channelUploadBusy).toBe(false);

    await act(async () => {
      actions.onRemoveUploadedChannelAttachment("existing");
    });

    expect(latestState?.uploadedChannelAttachments.map((item) => item.attachmentId)).toEqual(["fresh"]);
  });
});
