import { AreaHeader } from "../../../ui/AreaHeader";
import { AREA_COLUMN } from "../../../ui/area-layout";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Section } from "../../../ui/Section";
import type { ChannelPickerGroupView, ChannelPickerTile } from "./channel-picker-model";
import { useChannelPickerGroups } from "./use-channel-picker-groups";

/** A tile is one link: the channel's name, about how long setup takes, and what it needs. */
function Tile({ tile, workspaceId }: { tile: ChannelPickerTile; workspaceId: string }) {
  return (
    <li>
      <NativeOwnerLink
        href={tile.href}
        scope={workspaceId}
        className="flex min-h-11 w-full flex-col gap-0.5 rounded-md border border-line-subtle bg-raised p-3 text-fg hover:border-line hover:bg-sunken hover:no-underline"
      >
        <span className="text-sm font-medium">{tile.label}</span>
        <span className="text-xs text-fg-muted">About {tile.minutes} min</span>
        {tile.note ? <span className="text-xs text-fg-secondary">{tile.note}</span> : null}
      </NativeOwnerLink>
    </li>
  );
}

function Group({ group, workspaceId }: { group: ChannelPickerGroupView; workspaceId: string }) {
  return (
    <Section title={group.title}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {group.tiles.map((tile) => (
          <Tile key={tile.channelKey} tile={tile} workspaceId={workspaceId} />
        ))}
      </ul>
    </Section>
  );
}

/**
 * Choosing a channel to add, in Chat beside its Messaging list. The channels come grouped from the setup catalogue;
 * loading and failure are plain text, because this page reads once and has nothing to announce.
 */
export function ChannelPicker({ workspaceId }: { workspaceId: string }) {
  const { groups, isPending, isError, refetch } = useChannelPickerGroups();
  return (
    <section aria-label="Add a channel" className={`${AREA_COLUMN} grid min-w-0 gap-6 p-4 md:p-6`}>
      <AreaHeader
        title="Add a channel"
        description="Pick where you want to talk to GoatCitadel."
        actions={
          <NativeOwnerLink href="/chat" scope={workspaceId} className="text-sm">
            Back to conversations
          </NativeOwnerLink>
        }
      />
      {groups ? (
        groups.length ? (
          groups.map((group) => <Group key={group.id} group={group} workspaceId={workspaceId} />)
        ) : (
          <p className="text-sm text-fg-muted">No channels are available to add.</p>
        )
      ) : isError ? (
        <>
          <Callout announce={false} tone="error">
            <p>Couldn't load the channels.</p>
          </Callout>
          <div>
            <Button onClick={() => void refetch()}>Try again</Button>
          </div>
        </>
      ) : isPending ? (
        <p className="text-sm text-fg-muted">Loading channels…</p>
      ) : null}
    </section>
  );
}
