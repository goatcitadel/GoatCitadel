import type { UseQueryResult } from "@tanstack/react-query";
import type { ChannelRuntimeStatus, IntegrationConnection } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import { MetricList } from "../../ui/MetricList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Section } from "../../ui/Section";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { ChannelLifecycleControls } from "../settings/ChannelLifecycleControls";
import { postingTargets } from "./channel-page-model";

/** What the last check says, in words. A check that did not finish never reads as healthy or as broken. */
function workingSummary(runtime: UseQueryResult<ChannelRuntimeStatus>, label: string): string {
  const data = runtime.data;
  if (!data) return runtime.isError ? "Couldn't check this channel just now." : "Checking this channel…";
  const base = !data.enabled
    ? `${label} is turned off.`
    : data.ready
      ? `GoatCitadel is connected to ${label}.`
      : "Not connected right now.";
  return runtime.isRefetchError ? `${base} The latest check didn't finish.` : base;
}

/** Whether the channel is working: what its last check found, when a message last arrived, and a check on demand. */
export function WorkingSection({ label, runtime }: { label: string; runtime: UseQueryResult<ChannelRuntimeStatus> }) {
  const data = runtime.data;
  return (
    <Section
      title="Whether it's working"
      actions={
        <Button onClick={() => void runtime.refetch()} loading={runtime.isFetching} loadingLabel="Checking…">
          Check now
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-fg-secondary">{workingSummary(runtime, label)}</p>
        {data ? (
          <MetricList
            items={[
              {
                term: "Last message",
                value: data.lastInboundAt ? <TimeText value={data.lastInboundAt} /> : "No messages yet",
              },
              {
                term: "Checked",
                value: runtime.dataUpdatedAt ? <TimeText value={runtime.dataUpdatedAt} /> : "Not yet",
              },
            ]}
          />
        ) : null}
        {data?.lastError ? (
          <TechnicalDetails label="Last problem reported">
            <p>{data.lastError}</p>
          </TechnicalDetails>
        ) : null}
      </div>
    </Section>
  );
}

/** Where it posts: the default places by name. A provider's id is never the name. */
export function PostsSection({ connection }: { connection: IntegrationConnection }) {
  const targets = postingTargets(connection);
  return (
    <Section title="Where it posts" description="Where GoatCitadel posts when you don't say where.">
      {targets.length ? (
        <ul className="divide-y divide-line-subtle">
          {targets.map((target, index) => (
            <li key={`${index}:${target.label}`} className="py-2 text-base text-fg">
              {target.label}
              {target.isDefault ? <span className="text-fg-muted">{" · Default"}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">No default place to post is saved for this channel.</p>
      )}
    </Section>
  );
}

/** Turn off or remove, and the way to a new key. Remove stays the only danger action, inside the lifecycle controls. */
export function ManageSection({
  connection,
  workspaceId,
  reload,
}: {
  connection: IntegrationConnection;
  workspaceId: string;
  reload: () => Promise<unknown>;
}) {
  return (
    <Section title="Turn off or remove">
      <div className="space-y-3">
        <ChannelLifecycleControls
          key={`lifecycle:${connection.connectionId}`}
          workspaceId={workspaceId}
          selection={{ connection }}
          reload={reload}
        />
        <NativeOwnerLink href="/settings/connections#channels" scope={workspaceId} className="block text-sm">
          Change the key
        </NativeOwnerLink>
      </div>
    </Section>
  );
}
