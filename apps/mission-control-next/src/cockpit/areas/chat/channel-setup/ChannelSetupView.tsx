import type { ComponentType } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { channelPageHref, channelPickerHref, type MessagingView } from "../../../app/routes";
import { settingsChannelSetupHref } from "./channel-picker-model";
import { useChannelConnection } from "../use-channel-connections";
import { ChannelTokenChange } from "./ChannelTokenChange";
import { DiscordSetupPage } from "./DiscordSetupPage";
import { SetupFrame as Frame } from "./SetupFrame";
import { SlackSetupPage } from "./SlackSetupPage";
import { TelegramKeyChange } from "./TelegramKeyChange";
import { TelegramSetupPage } from "./TelegramSetupPage";
import { useChannelPickerGroups } from "./use-channel-picker-groups";

/** The views this page shows: a channel's setup, and a channel's key change. */
export type ChannelSetupViewTarget = Extract<MessagingView, { kind: "setup" | "change_key" }>;

/** What a channel's own setup page is given. */
interface SetupPageProps {
  workspaceId: string;
  /** The unfinished setup to go on with, when the address names one. */
  resumeDraftId?: string;
}

/** What a channel's own key-change page is given: the channel to change, which the view has read already. */
interface KeyChangePageProps {
  connectionId: string;
  connection: IntegrationConnection;
  workspaceId: string;
}

/**
 * The channels with a setup page of their own, by catalog key. A channel not here has none yet: its setup is Settings'
 * (`CONVERTED_SETUP_CHANNELS` lists the ones the picker opens in Chat). A map, not an object, so a name like
 * "constructor" is never taken for a channel.
 */
export const SETUP_PAGES: ReadonlyMap<string, ComponentType<SetupPageProps>> = new Map([
  ["telegram", TelegramSetupPage],
  ["discord", DiscordSetupPage],
  ["slack", SlackSetupPage],
]);

/**
 * The channels whose key is changed on a page of their own in Chat, by catalog key. `KEY_CHANGE_CHANNELS` lists the same
 * keys for the channel page, which links here without loading these pages.
 */
export const KEY_CHANGE_PAGES: ReadonlyMap<string, ComponentType<KeyChangePageProps>> = new Map<
  string,
  ComponentType<KeyChangePageProps>
>([
  ["telegram", TelegramKeyChange],
  ["discord", ChannelTokenChange],
  ["slack", ChannelTokenChange],
]);

/**
 * Changing a channel's key. A channel with a key page of its own is changed there. Any other channel's key is Settings'
 * still, so this says so and links there: also while the channel cannot be read, because Settings can still change it.
 */
function KeyChange({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) {
  const { connection, connections } = useChannelConnection(connectionId);
  const Page = connection ? KEY_CHANGE_PAGES.get(connection.key) : undefined;
  if (connection && Page) return <Page connectionId={connectionId} connection={connection} workspaceId={workspaceId} />;
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
 * One channel's setup. A channel with a page of its own opens it; a channel without one sends the operator to
 * Settings, which has its steps; a channel the picker does not offer is not available here, whatever the address says.
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
  const Page = SETUP_PAGES.get(tile.channelKey);
  if (Page) return <Page workspaceId={workspaceId} resumeDraftId={draftId} />;
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
