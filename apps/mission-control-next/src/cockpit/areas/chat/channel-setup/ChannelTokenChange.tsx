import { useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChannelRuntimeStatus, IntegrationConnection } from "@goatcitadel/contracts";
import { fetchChannelRuntimeStatus } from "@goatcitadel/mission-control-shared/api/client";
import { HOSTS_UNKNOWN, useMissingHosts } from "../../../../features/native-routes/settings/channel-hosts";
import { channelPageHref } from "../../../app/routes";
import { queryKeys } from "../../../data/query-keys";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { CONNECTIONS_QUERY_KEY } from "../use-channel-connections";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { botChanged, botChangeNote, runningBotName } from "./token-change-model";
import { TOKEN_CHANGE_CHANNELS, type TokenChangeChannel } from "./token-change-channels";
import { hostChange, TEST_MESSAGE_THERE_CHANGE, TurnOnStep, turnOnStatus } from "./TurnOnStep";
import { useChannelSetupHosts } from "./use-channel-picker-groups";
import { useTokenChange, type TokenChangeState } from "./use-token-change";
import { useTurnOn, type TurnOnState } from "./use-turn-on";

/** What the page tells a screen reader after each thing happens: the one status line, latest first. */
function statusLine(
  channel: TokenChangeChannel,
  change: TokenChangeState,
  turnOn: TurnOnState,
  botChange: string | undefined,
  hostsFailed: boolean,
): string | undefined {
  if (change.error) return change.error;
  if (change.busy) return channel.checking;
  const saving = turnOnStatus(turnOn, channel.wording);
  if (saving) return saving;
  if (hostsFailed) return HOSTS_UNKNOWN;
  const { checked } = change;
  if (!checked) return undefined;
  if (checked.inTheWay) return `${checked.works} ${checked.inTheWay}`;
  return botChange ?? checked.works;
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <Callout tone="warning" announce={false}>
      <p>{children}</p>
    </Callout>
  );
}

/**
 * The name of the bot the channel has now, for the warning, when the channel can say it. It is asked only when the new
 * tokens are for a different bot, and the warning waits for the answer so it is not worded twice.
 */
function useBotItUsesNow(connectionId: string, channel: TokenChangeChannel, wanted: boolean) {
  const nameKey = channel.runningBotNameKey;
  const asked = wanted && nameKey !== undefined;
  const runtime = useQuery({
    queryKey: queryKeys.chatChannelRuntime(connectionId),
    queryFn: (): Promise<ChannelRuntimeStatus> => fetchChannelRuntimeStatus(connectionId),
    enabled: asked,
  });
  return {
    name: asked ? runningBotName(runtime.data?.metadata, nameKey) : undefined,
    pending: asked && runtime.isPending,
  };
}

/** The two steps for a channel that is there: paste the new tokens and have them checked, then save them. */
function TokenChangeSteps({
  connection,
  workspaceId,
  channel,
}: {
  connection: IntegrationConnection;
  workspaceId: string;
  channel: TokenChangeChannel;
}) {
  const { connectionId, config } = connection;
  const queryClient = useQueryClient();
  const change = useTokenChange(connection, channel);
  const turnOn = useTurnOn(workspaceId, change.draft?.draftId);
  const { checked, draft } = change;
  // Tokens for a bot that cannot be used yet (Discord's Message Content Intent is off) wait to be checked again.
  const ready = checked !== null && checked.inTheWay === undefined;
  const saved = turnOn.state === "done";
  const requiredHosts = useChannelSetupHosts(channel.catalogId, draft);
  // Read once there is a step to save, as on the setup page. Saving waits until the read says which hosts it adds.
  const hosts = useMissingHosts(requiredHosts, ready);
  const switched = ready && botChanged(config, channel.savedBotKey, checked.botId);
  const botItUsesNow = useBotItUsesNow(connectionId, channel, switched);
  const botChange =
    switched && !botItUsesNow.pending ? botChangeNote(channel.many, checked.botName, botItUsesNow.name) : undefined;

  // The channel's page reads the channel again, so it shows the new bot rather than the one from before.
  useEffect(() => {
    if (!saved) return;
    void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chatChannelRuntime(connectionId) });
  }, [saved, queryClient, connectionId]);

  const saveStep = ready ? (
    <div className="space-y-3">
      {botChange && !saved ? <Warning>{botChange}</Warning> : null}
      <TurnOnStep
        changes={[TEST_MESSAGE_THERE_CHANGE, ...hosts.missing.map(hostChange)]}
        turnOn={turnOn}
        wording={channel.wording}
        onTurnOn={() => {
          if (draft && requiredHosts && hosts.known) {
            const target = { draftId: draft.draftId, catalogId: channel.catalogId };
            void turnOn.turnOn({ ...target, requiredHosts, shownHosts: hosts.missing });
          }
        }}
        doneHref={channelPageHref(connectionId)}
        disabled={!requiredHosts || !hosts.known || botItUsesNow.pending}
        workspaceId={workspaceId}
        retryHostCheck={hosts.failed ? hosts.retry : undefined}
      />
    </div>
  ) : undefined;
  const steps: SetupStepView[] = [
    {
      id: "new-tokens",
      title: channel.pasteTitle,
      state: ready ? "done" : "current",
      result: checked?.works,
      children: (
        <channel.Fields
          workspaceId={workspaceId}
          connectionId={connectionId}
          checked={checked}
          busy={change.busy}
          error={change.error}
          onCheck={(tokens) => void change.checkTokens(tokens)}
          onRecheck={() => void change.recheck()}
        />
      ),
    },
    {
      id: "save-key",
      title: channel.saveTitle,
      state: !ready ? "locked" : saved ? "done" : "current",
      result: saved ? saveStep : undefined,
      children: saveStep,
    },
  ];

  return (
    <SetupFrame
      title={channel.title}
      back={{ href: channelPageHref(connectionId), label: "Back to channel" }}
      workspaceId={workspaceId}
    >
      <SetupSteps steps={steps} status={statusLine(channel, change, turnOn, botChange, hosts.failed)} />
    </SetupFrame>
  );
}

/**
 * Changing a Discord or Slack channel's tokens from its page in Chat: paste the new token (Slack's two), have them
 * checked, then save them. Saving is the same step as turning a channel on (a test message, then the change, approved in
 * place), with the words of changing a key. A channel that is not Discord or Slack is changed in Settings.
 */
export function ChannelTokenChange({
  connection,
  workspaceId,
}: {
  connection: IntegrationConnection;
  workspaceId: string;
}) {
  const channel = TOKEN_CHANGE_CHANNELS.get(connection.key);
  if (channel) return <TokenChangeSteps connection={connection} workspaceId={workspaceId} channel={channel} />;
  return (
    <SetupFrame
      title="Change this channel's key"
      description="You can't change a key from Chat yet. Settings has it."
      back={{ href: channelPageHref(connection.connectionId), label: "Back to channel" }}
      workspaceId={workspaceId}
    >
      <NativeOwnerLink href="/settings/connections#channels" scope={workspaceId} className="text-sm">
        Change the key in Settings
      </NativeOwnerLink>
    </SetupFrame>
  );
}
