import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { channelPageHref, channelPickerHref, type MessagingView } from "../../../app/routes";
import { settingsChannelSetupHref } from "./channel-picker-model";
import { useChannelConnection } from "../use-channel-connections";
import { SetupFrame as Frame } from "./SetupFrame";
import { TelegramKeyChange } from "./TelegramKeyChange";
import { TelegramSetupPage } from "./TelegramSetupPage";
import { useChannelPickerGroups } from "./use-channel-picker-groups";

/** The views this page shows: a channel's setup, and a channel's key change. */
export type ChannelSetupViewTarget = Extract<MessagingView, { kind: "setup" | "change_key" }>;

/**
 * Changing a channel's key. Telegram's is changed here, on its own page. Any other channel's key is Settings' still,
 * so this says so and links there: also while the channel cannot be read, because Settings can still change it.
 */
function KeyChange({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) {
  const { connection, connections } = useChannelConnection(connectionId);
  if (connection?.key === "telegram")
    return <TelegramKeyChange connectionId={connectionId} workspaceId={workspaceId} />;
  const back = { href: channelPageHref(connectionId), label: "Back to channel" };
  if (connections.isPending) {
    return (
      <Frame title="Change this channel's key" back={back} workspaceId={workspaceId}>
        <p className="text-sm text-fg-muted">Loading channel…</p>
      </Frame>
    );
  }
  return (
    <Frame
      title="Change this channel's key"
      description="You can't change a key from Chat yet. Settings has it."
      back={back}
      workspaceId={workspaceId}
    >
      <NativeOwnerLink href="/settings/connections#channels" scope={workspaceId} className="text-sm">
        Change the key in Settings
      </NativeOwnerLink>
    </Frame>
  );
}

/**
 * One channel's setup. Telegram has its own page; a channel without one sends the operator to Settings, which has
 * its steps; a channel the picker does not offer is not available here, whatever the address says.
 */
function ChannelSetup({
  channelKey,
  draftId,
  workspaceId,
}: {
  channelKey: string;
  /** The unfinished setup to go on with, when the address names one. */
  draftId?: string;
  workspaceId: string;
}) {
  const { groups, isError, isPending, refetch } = useChannelPickerGroups();
  const back = { href: channelPickerHref(), label: "Back to channels" };
  if (!groups) {
    return (
      <Frame title="Add a channel" back={back} workspaceId={workspaceId}>
        {isError ? (
          <>
            <Callout announce={false} tone="error">
              <p>Couldn't load this channel.</p>
            </Callout>
            <div>
              <Button onClick={() => void refetch()}>Try again</Button>
            </div>
          </>
        ) : isPending ? (
          <p className="text-sm text-fg-muted">Loading channel…</p>
        ) : null}
      </Frame>
    );
  }
  const tile = groups.flatMap((group) => group.tiles).find((candidate) => candidate.channelKey === channelKey);
  if (!tile) {
    return (
      <Frame title="Add a channel" back={back} workspaceId={workspaceId}>
        <p className="text-base text-fg-secondary">This channel isn't available.</p>
      </Frame>
    );
  }
  if (tile.channelKey === "telegram") return <TelegramSetupPage workspaceId={workspaceId} resumeDraftId={draftId} />;
  return (
    <Frame
      title={`Add ${tile.label}`}
      description={`You can't set up ${tile.label} from Chat yet. Its steps are in Settings.`}
      back={back}
      workspaceId={workspaceId}
    >
      <NativeOwnerLink href={settingsChannelSetupHref(tile.catalogId)} scope={workspaceId} className="text-sm">
        Set up {tile.label} in Settings
      </NativeOwnerLink>
    </Frame>
  );
}

/** A channel's setup, or a channel's key change, in Chat beside its Messaging list. */
export function ChannelSetupView({ view, workspaceId }: { view: ChannelSetupViewTarget; workspaceId: string }) {
  return view.kind === "setup" ? (
    <ChannelSetup channelKey={view.channelKey} draftId={view.draftId} workspaceId={workspaceId} />
  ) : (
    <KeyChange connectionId={view.connectionId} workspaceId={workspaceId} />
  );
}
