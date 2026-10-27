import type { ReactNode } from "react";
import { AreaHeader } from "../../../ui/AreaHeader";
import { AREA_COLUMN } from "../../../ui/area-layout";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { channelPageHref, channelPickerHref, type MessagingView } from "../../../app/routes";
import { settingsChannelSetupHref } from "./channel-picker-model";
import { useChannelPickerGroups } from "./use-channel-picker-groups";

/** The views this page shows: a channel's setup, and, until it has its own page, a channel's key change. */
export type ChannelSetupViewTarget = Extract<MessagingView, { kind: "setup" | "change_key" }>;

function Frame({
  title,
  description,
  back,
  workspaceId,
  children,
}: {
  title: string;
  description?: string;
  back: { href: string; label: string };
  workspaceId: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title} className={`${AREA_COLUMN} grid min-w-0 gap-6 p-4 md:p-6`}>
      <AreaHeader
        title={title}
        description={description}
        actions={
          <NativeOwnerLink href={back.href} scope={workspaceId} className="text-sm">
            {back.label}
          </NativeOwnerLink>
        }
      />
      {children}
    </section>
  );
}

/**
 * Changing a channel's key. Settings still owns it, so this says so and links there; the page itself comes later.
 */
function KeyChange({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) {
  return (
    <Frame
      title="Change this channel's key"
      description="You can't change a key from Chat yet. Settings has it."
      back={{ href: channelPageHref(connectionId), label: "Back to channel" }}
      workspaceId={workspaceId}
    >
      <NativeOwnerLink href="/settings/connections#channels" scope={workspaceId} className="text-sm">
        Change the key in Settings
      </NativeOwnerLink>
    </Frame>
  );
}

/**
 * One channel's setup. A channel without a setup page of its own sends the operator to Settings, which has its
 * steps; a channel the picker does not offer is not available here, whatever the address says.
 */
function ChannelSetup({ channelKey, workspaceId }: { channelKey: string; workspaceId: string }) {
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
    <ChannelSetup channelKey={view.channelKey} workspaceId={workspaceId} />
  ) : (
    <KeyChange connectionId={view.connectionId} workspaceId={workspaceId} />
  );
}
