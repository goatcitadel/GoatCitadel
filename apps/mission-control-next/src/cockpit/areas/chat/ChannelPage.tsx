import type { ReactNode } from "react";
import { describeRetiredChannel, type ChatMessagingChannelStatus } from "@goatcitadel/contracts";
import { presentChannelStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_COLUMN } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { EmptyState } from "../../ui/EmptyState";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import { botIdentity } from "./channel-page-model";
import { PeopleSection } from "./ChannelPeopleSection";
import { ChannelLockNote } from "./ChannelLockNote";
import { ManageSection } from "./ChannelManageSection";
import { PostsSection, WorkingSection } from "./ChannelPageSections";
import { useChannelPageData } from "./use-channel-page-data";

/** The page frame: the channel's name, what it says it is connected as, and its status as the Gateway reports it. */
function PageFrame({
  title,
  detail,
  status,
  workspaceId,
  children,
}: {
  title: string;
  detail?: string;
  status?: ChatMessagingChannelStatus;
  workspaceId: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label="Channel" className={`${AREA_COLUMN} grid min-w-0 gap-6 p-4 md:p-6`}>
      <AreaHeader
        title={title}
        description={detail}
        actions={
          <NativeOwnerLink href="/chat" scope={workspaceId} className="text-sm">
            Back to conversations
          </NativeOwnerLink>
        }
      >
        {status ? <StatusBadge status={presentChannelStatus(status)} className="mt-2" /> : null}
      </AreaHeader>
      {children}
    </section>
  );
}

/**
 * One connected channel, in Chat beside its Messaging list: whether it is working, who can message it, where it
 * posts, and how to turn it off, remove it or change its key. A removed channel keeps only its name and the note
 * that its conversations are still readable.
 */
export function ChannelPage({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) {
  const { connection, channel, connections, overview, runtime, senderRecords, approved, pending, openAccess, reload } =
    useChannelPageData(connectionId, workspaceId);
  const status = channel?.status;

  if (connection) {
    // A retired channel's connection stays saved as it was left, so the Gateway's overview may not say "removed" yet.
    // It is out of service for good: its past conversations stay readable and the connection can be removed, nothing
    // else (no runtime check, people, posting places, switch or key change, which would imply it can send).
    const retiredReason = describeRetiredChannel(connection.key);
    if (retiredReason) {
      return (
        <PageFrame title={connection.label} status="removed" workspaceId={workspaceId}>
          <ChannelLockNote connectionId={connection.connectionId} reload={reload} />
          <Callout announce={false}>
            <p>{retiredReason}</p>
          </Callout>
          <p className="text-base text-fg-secondary">
            Its conversations stay readable under{" "}
            <NativeOwnerLink href="/chat" scope={workspaceId}>
              Messaging
            </NativeOwnerLink>
            .
          </p>
          <ManageSection connection={connection} workspaceId={workspaceId} reload={reload} removeOnly />
        </PageFrame>
      );
    }
    return (
      <PageFrame
        title={connection.label}
        detail={botIdentity(connection, runtime.data?.metadata)}
        status={status}
        workspaceId={workspaceId}
      >
        <ChannelLockNote connectionId={connection.connectionId} reload={reload} />
        <WorkingSection label={connection.label} runtime={runtime} />
        <PeopleSection
          connection={connection}
          approved={approved}
          pending={pending}
          openAccess={openAccess}
          loading={senderRecords.isPending && senderRecords.fetchStatus !== "idle"}
          failed={senderRecords.isError}
          reload={reload}
        />
        <PostsSection connection={connection} />
        <ManageSection connection={connection} workspaceId={workspaceId} reload={reload} />
      </PageFrame>
    );
  }

  if (connections.isError || (!connections.isPending && overview.isError)) {
    return (
      <PageFrame title="Channel" workspaceId={workspaceId}>
        <Callout announce={false} tone="error">
          <p>Couldn't load this channel.</p>
        </Callout>
        <div>
          <Button onClick={() => void reload()}>Try again</Button>
        </div>
      </PageFrame>
    );
  }

  // Just removed: the connection list has caught up before the overview says so, which is not "not found".
  const catchingUp = channel !== undefined && channel.status !== "removed" && overview.isFetching;
  if (connections.isPending || overview.isPending || catchingUp) {
    return (
      <PageFrame title="Channel" workspaceId={workspaceId}>
        <p className="text-sm text-fg-muted">Loading channel…</p>
      </PageFrame>
    );
  }

  if (channel?.status === "removed") {
    return (
      <PageFrame title={channel.label} status="removed" workspaceId={workspaceId}>
        <p className="text-base text-fg-secondary">
          This channel was removed. Its conversations stay readable under{" "}
          <NativeOwnerLink href="/chat" scope={workspaceId}>
            Messaging
          </NativeOwnerLink>
          .
        </p>
      </PageFrame>
    );
  }

  return (
    <PageFrame title="Channel" workspaceId={workspaceId}>
      <EmptyState
        headingLevel={2}
        title="We couldn't find this channel"
        description="It may have been removed. Conversations from a removed channel stay readable under Messaging."
      />
    </PageFrame>
  );
}
