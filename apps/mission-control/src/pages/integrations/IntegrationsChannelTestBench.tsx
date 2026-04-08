import type {
  ChannelRuntimeStatus,
  ChatAttachmentRecord,
  ConnectorRecord,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
} from "@goatcitadel/contracts";
import type { IntegrationConnection } from "../../api/client";
import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";
import { GCSelect } from "../../components/ui";
import {
  connectorSetupReady,
  connectorSupportsDeliveryAction,
  formatConnectorList,
  getConnectorRuntimePostureSummary,
  getConnectorSetupDiagnostics,
  getConnectorSupportNotes,
  getConnectorSupportedAttachmentSources,
  getConnectorSupportedDeliveryActions,
  guessDefaultChannelTarget,
  isDiscordGatewayConnection,
} from "../integrations-page-utils";

export interface IntegrationsChannelTestBenchProps {
  channelConnections: IntegrationConnection[];
  selectedChannelConnectionId: string;
  onSelectedChannelConnectionIdChange: (value: string) => void;
  selectedChannelConnection: IntegrationConnection | null;
  selectedChannelConnector: ConnectorRecord | undefined;
  selectedChannelRuntimeStatus: ChannelRuntimeStatus | undefined;
  selectedDiscordRuntime: DiscordRuntimeStatus | undefined;
  selectedDiscordPairings: DiscordPairingRecord[];
  channelTestTarget: string;
  onChannelTestTargetChange: (value: string) => void;
  channelTestBusy: boolean;
  onSendChannelTest: () => void;
  onReconnectDiscordRuntime: (connectionId: string) => void;
  onApproveDiscordPairing: (connectionId: string, pairingId: string) => void;
  onRevokeDiscordPairing: (connectionId: string, pairingId: string) => void;
  discordPairingBusyId: string | null;
  channelTestMessage: string;
  onChannelTestMessageChange: (value: string) => void;
  channelSubject: string;
  onChannelSubjectChange: (value: string) => void;
  channelEffectId: string;
  onChannelEffectIdChange: (value: string) => void;
  channelReplyToMessageId: string;
  onChannelReplyToMessageIdChange: (value: string) => void;
  channelReplyToPartIndex: string;
  onChannelReplyToPartIndexChange: (value: string) => void;
  channelAttachmentUrls: string;
  onChannelAttachmentUrlsChange: (value: string) => void;
  channelAttachmentIdsText: string;
  onChannelAttachmentIdsTextChange: (value: string) => void;
  channelUploadBusy: boolean;
  onUploadChannelAttachments: (files: FileList | null) => void;
  uploadedChannelAttachments: ChatAttachmentRecord[];
  onRemoveUploadedChannelAttachment: (attachmentId: string) => void;
  channelTestResult: string | null;
  channelReactionMessageId: string;
  onChannelReactionMessageIdChange: (value: string) => void;
  channelReactionEmoji: string;
  onChannelReactionEmojiChange: (value: string) => void;
  channelActionBusy: "react" | "unsend" | null;
  onReactChannelTest: () => void;
  channelUnsendMessageId: string;
  onChannelUnsendMessageIdChange: (value: string) => void;
  onUnsendChannelTest: () => void;
  channelActionResult: string | null;
}

export function IntegrationsChannelTestBench(props: IntegrationsChannelTestBenchProps) {
  const {
    channelConnections,
    selectedChannelConnectionId,
    onSelectedChannelConnectionIdChange,
    selectedChannelConnection,
    selectedChannelConnector,
    selectedChannelRuntimeStatus,
    selectedDiscordRuntime,
    selectedDiscordPairings,
    channelTestTarget,
    onChannelTestTargetChange,
    channelTestBusy,
    onSendChannelTest,
    onReconnectDiscordRuntime,
    onApproveDiscordPairing,
    onRevokeDiscordPairing,
    discordPairingBusyId,
    channelTestMessage,
    onChannelTestMessageChange,
    channelSubject,
    onChannelSubjectChange,
    channelEffectId,
    onChannelEffectIdChange,
    channelReplyToMessageId,
    onChannelReplyToMessageIdChange,
    channelReplyToPartIndex,
    onChannelReplyToPartIndexChange,
    channelAttachmentUrls,
    onChannelAttachmentUrlsChange,
    channelAttachmentIdsText,
    onChannelAttachmentIdsTextChange,
    channelUploadBusy,
    onUploadChannelAttachments,
    uploadedChannelAttachments,
    onRemoveUploadedChannelAttachment,
    channelTestResult,
    channelReactionMessageId,
    onChannelReactionMessageIdChange,
    channelReactionEmoji,
    onChannelReactionEmojiChange,
    channelActionBusy,
    onReactChannelTest,
    channelUnsendMessageId,
    onChannelUnsendMessageIdChange,
    onUnsendChannelTest,
    channelActionResult,
  } = props;

  return (
    <Panel
      title="Channel Test Bench"
      subtitle="Send operator test messages through each channel adapter with the exact delivery semantics that connection uses."
    >
      {channelConnections.length === 0 ? (
        <p className="table-subtext">No channel connections configured yet. Create one above, then validate it here.</p>
      ) : (
        <>
          <div className="controls-row">
            <label htmlFor="channelTestConnection">Channel connection</label>
            <GCSelect
              id="channelTestConnection"
              value={selectedChannelConnectionId}
              onChange={(value) => onSelectedChannelConnectionIdChange(value)}
              options={channelConnections.map((connection) => ({
                value: connection.connectionId,
                label: `${connection.label} (${connection.key})`,
              }))}
            />
            <label htmlFor="channelTestTarget">Target</label>
            <input
              id="channelTestTarget"
              value={channelTestTarget}
              onChange={(event) => onChannelTestTargetChange(event.target.value)}
              placeholder="channel / room / chat id / thread key"
            />
            <button type="button" onClick={() => onSendChannelTest()} disabled={channelTestBusy}>
              {channelTestBusy ? "Sending..." : "Send test"}
            </button>
          </div>
          {selectedChannelConnection ? (
            <>
              <p className="office-subtitle">
                Adapter: {selectedChannelConnection.key}
                {" · "}
                Status: {selectedChannelConnection.status}
                {" · "}
                Suggested default target: {guessDefaultChannelTarget(selectedChannelConnection) || "none configured"}
              </p>
              {selectedChannelConnector ? (
                <div className="card" style={{ marginBottom: 12 }}>
                  <p>
                    <strong>Connector readiness</strong>
                    {" · "}
                    {connectorSetupReady(selectedChannelConnector) ? "ready" : "needs attention"}
                  </p>
                  <p className="office-subtitle">
                    Supported actions:{" "}
                    {formatConnectorList(getConnectorSupportedDeliveryActions(selectedChannelConnector))}
                    {" | "}
                    Attachment sources:{" "}
                    {formatConnectorList(getConnectorSupportedAttachmentSources(selectedChannelConnector))}
                  </p>
                  <p className="office-subtitle">
                    Runtime posture:{" "}
                    {selectedChannelRuntimeStatus?.runtimePosture?.operatorSummary ??
                      getConnectorRuntimePostureSummary(selectedChannelConnector) ??
                      "not reported"}
                    {" | "}
                    Runtime ready:{" "}
                    {selectedChannelRuntimeStatus ? (selectedChannelRuntimeStatus.ready ? "yes" : "no") : "unknown"}
                  </p>
                  {selectedChannelRuntimeStatus ? (
                    <p className="office-subtitle">
                      Last ready:{" "}
                      {selectedChannelRuntimeStatus.lastReadyAt
                        ? new Date(selectedChannelRuntimeStatus.lastReadyAt).toLocaleString()
                        : "never"}
                      {" | "}
                      Last inbound:{" "}
                      {selectedChannelRuntimeStatus.lastInboundAt
                        ? new Date(selectedChannelRuntimeStatus.lastInboundAt).toLocaleString()
                        : "never"}
                      {selectedChannelRuntimeStatus.lastError
                        ? ` | Runtime error: ${selectedChannelRuntimeStatus.lastError}`
                        : ""}
                    </p>
                  ) : null}
                  {getConnectorSupportNotes(selectedChannelConnector).length > 0 ? (
                    <>
                      <p className="office-subtitle">
                        <strong>Support notes</strong>
                      </p>
                      <ul className="improvement-simple-list">
                        {getConnectorSupportNotes(selectedChannelConnector).map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {getConnectorSetupDiagnostics(selectedChannelConnector).length > 0 ? (
                    <>
                      <p className="office-subtitle">
                        <strong>Setup diagnostics</strong>
                      </p>
                      <ul className="improvement-simple-list">
                        {getConnectorSetupDiagnostics(selectedChannelConnector).map((diagnostic) => (
                          <li key={diagnostic}>{diagnostic}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              ) : null}
              {isDiscordGatewayConnection(selectedChannelConnection) ? (
                <div className="card" style={{ marginBottom: 12 }}>
                  <p>
                    <strong>Discord gateway runtime</strong>
                    {" · "}
                    {selectedDiscordRuntime?.ready ? "logged in" : "not ready"}
                  </p>
                  <p className="office-subtitle">
                    Bot: {selectedDiscordRuntime?.connectedBotTag ?? "unknown"}
                    {" | "}
                    Last inbound:{" "}
                    {selectedDiscordRuntime?.lastInboundAt
                      ? new Date(selectedDiscordRuntime.lastInboundAt).toLocaleString()
                      : "never"}
                    {" | "}
                    Last reconnect:{" "}
                    {selectedDiscordRuntime?.lastReconnectAt
                      ? new Date(selectedDiscordRuntime.lastReconnectAt).toLocaleString()
                      : "never"}
                  </p>
                  <p className="office-subtitle">
                    Guilds connected:{" "}
                    {selectedDiscordRuntime?.guildIds?.length
                      ? selectedDiscordRuntime.guildIds.join(", ")
                      : "none reported"}
                  </p>
                  {selectedDiscordRuntime?.lastError ? (
                    <FieldHelp>Runtime error: {selectedDiscordRuntime.lastError}</FieldHelp>
                  ) : null}
                  <div className="controls-row" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => onReconnectDiscordRuntime(selectedChannelConnection.connectionId)}
                      disabled={discordPairingBusyId === `reconnect:${selectedChannelConnection.connectionId}`}
                    >
                      {discordPairingBusyId === `reconnect:${selectedChannelConnection.connectionId}`
                        ? "Reconnecting..."
                        : "Reconnect Discord runtime"}
                    </button>
                  </div>
                  <p className="office-subtitle" style={{ marginTop: 12 }}>
                    <strong>Pairings</strong>
                  </p>
                  {selectedDiscordPairings.length === 0 ? (
                    <FieldHelp>No pending or approved Discord peers yet.</FieldHelp>
                  ) : (
                    <ul className="improvement-simple-list">
                      {selectedDiscordPairings.map((pairing) => (
                        <li key={pairing.pairingId}>
                          <strong>{pairing.displayName ?? pairing.userId}</strong>
                          {" · "}
                          {pairing.status}
                          {" · "}
                          code {pairing.code}
                          {pairing.lastInboundAt
                            ? ` · last inbound ${new Date(pairing.lastInboundAt).toLocaleString()}`
                            : ""}{" "}
                          {pairing.status !== "approved" ? (
                            <button
                              type="button"
                              onClick={() =>
                                onApproveDiscordPairing(selectedChannelConnection.connectionId, pairing.pairingId)
                              }
                              disabled={discordPairingBusyId === `approve:${pairing.pairingId}`}
                            >
                              {discordPairingBusyId === `approve:${pairing.pairingId}` ? "Approving..." : "Approve"}
                            </button>
                          ) : null}{" "}
                          {pairing.status !== "revoked" ? (
                            <button
                              type="button"
                              onClick={() =>
                                onRevokeDiscordPairing(selectedChannelConnection.connectionId, pairing.pairingId)
                              }
                              disabled={discordPairingBusyId === `revoke:${pairing.pairingId}`}
                            >
                              {discordPairingBusyId === `revoke:${pairing.pairingId}` ? "Revoking..." : "Revoke"}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </>
          ) : null}
          <label htmlFor="channelTestMessage">Message</label>
          <textarea
            id="channelTestMessage"
            rows={5}
            className="full-textarea"
            value={channelTestMessage}
            onChange={(event) => onChannelTestMessageChange(event.target.value)}
          />
          <div className="controls-row" style={{ marginTop: 12 }}>
            <label htmlFor="channelSubject">Subject</label>
            <input
              id="channelSubject"
              value={channelSubject}
              onChange={(event) => onChannelSubjectChange(event.target.value)}
              placeholder="Optional subject (provider-specific)"
            />
            <label htmlFor="channelEffectId">Effect</label>
            <input
              id="channelEffectId"
              value={channelEffectId}
              onChange={(event) => onChannelEffectIdChange(event.target.value)}
              placeholder="Optional effect id"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="channelReplyToMessageId">Reply to message id</label>
            <input
              id="channelReplyToMessageId"
              value={channelReplyToMessageId}
              onChange={(event) => onChannelReplyToMessageIdChange(event.target.value)}
              placeholder="Optional provider message id"
            />
            <label htmlFor="channelReplyToPartIndex">Reply part index</label>
            <input
              id="channelReplyToPartIndex"
              value={channelReplyToPartIndex}
              onChange={(event) => onChannelReplyToPartIndexChange(event.target.value)}
              placeholder="0"
            />
          </div>
          <label htmlFor="channelAttachmentUrls">Attachment URLs</label>
          <textarea
            id="channelAttachmentUrls"
            rows={3}
            className="full-textarea"
            value={channelAttachmentUrls}
            onChange={(event) => onChannelAttachmentUrlsChange(event.target.value)}
            placeholder="One attachment URL per line"
          />
          <label htmlFor="channelAttachmentIdsText">Uploaded attachment ids</label>
          <textarea
            id="channelAttachmentIdsText"
            rows={2}
            className="full-textarea"
            value={channelAttachmentIdsText}
            onChange={(event) => onChannelAttachmentIdsTextChange(event.target.value)}
            placeholder="Optional attachment ids, one per line"
          />
          <div className="controls-row">
            <label htmlFor="channelAttachmentUpload">Upload attachment</label>
            <input
              id="channelAttachmentUpload"
              type="file"
              multiple
              onChange={(event) => {
                onUploadChannelAttachments(event.target.files);
                event.currentTarget.value = "";
              }}
              disabled={channelUploadBusy}
            />
            <span className="table-subtext">
              {channelUploadBusy ? "Uploading..." : "Uploads are stored as chat attachments and forwarded by id."}
            </span>
          </div>
          {uploadedChannelAttachments.length > 0 ? (
            <ul className="improvement-simple-list">
              {uploadedChannelAttachments.map((attachment) => (
                <li key={attachment.attachmentId}>
                  <strong>{attachment.fileName}</strong>
                  {" · "}
                  <code>{attachment.attachmentId}</code>
                  {" · "}
                  {attachment.mimeType}{" "}
                  <button type="button" onClick={() => onRemoveUploadedChannelAttachment(attachment.attachmentId)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {channelTestResult ? <p className="office-subtitle">{channelTestResult}</p> : null}
          {selectedChannelConnector ? (
            <div className="card" style={{ marginTop: 12 }}>
              <p>
                <strong>Interactive action bench</strong>
              </p>
              <p className="office-subtitle">
                Use provider message ids from a successful send or channel logs. Controls stay disabled unless the
                selected connector advertises that action.
              </p>
              <p className="table-subtext">
                Reaction format varies by provider: Slack and Mattermost expect emoji names, Discord accepts raw emoji,
                and iMessage uses BlueBubbles reaction keywords such as `love`.
              </p>
              <div className="controls-row">
                <label htmlFor="channelReactionMessageId">React message id</label>
                <input
                  id="channelReactionMessageId"
                  value={channelReactionMessageId}
                  onChange={(event) => onChannelReactionMessageIdChange(event.target.value)}
                  placeholder="provider message id"
                />
                <label htmlFor="channelReactionEmoji">Reaction</label>
                <input
                  id="channelReactionEmoji"
                  value={channelReactionEmoji}
                  onChange={(event) => onChannelReactionEmojiChange(event.target.value)}
                  placeholder="emoji"
                />
                <button
                  type="button"
                  onClick={() => onReactChannelTest()}
                  disabled={
                    channelActionBusy !== null ||
                    !connectorSupportsDeliveryAction(selectedChannelConnector, "channel.react")
                  }
                >
                  {channelActionBusy === "react" ? "Reacting..." : "Send reaction"}
                </button>
              </div>
              <div className="controls-row">
                <label htmlFor="channelUnsendMessageId">Unsend message id</label>
                <input
                  id="channelUnsendMessageId"
                  value={channelUnsendMessageId}
                  onChange={(event) => onChannelUnsendMessageIdChange(event.target.value)}
                  placeholder="provider message id"
                />
                <button
                  type="button"
                  onClick={() => onUnsendChannelTest()}
                  disabled={
                    channelActionBusy !== null ||
                    !connectorSupportsDeliveryAction(selectedChannelConnector, "channel.unsend")
                  }
                >
                  {channelActionBusy === "unsend" ? "Unsending..." : "Unsend message"}
                </button>
              </div>
              {!connectorSupportsDeliveryAction(selectedChannelConnector, "channel.react") &&
              !connectorSupportsDeliveryAction(selectedChannelConnector, "channel.unsend") ? (
                <p className="table-subtext">
                  This connector is send-only right now. The backend will keep rejecting interactive actions until the
                  underlying provider bridge supports them.
                </p>
              ) : null}
              {channelActionResult ? <p className="office-subtitle">{channelActionResult}</p> : null}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
