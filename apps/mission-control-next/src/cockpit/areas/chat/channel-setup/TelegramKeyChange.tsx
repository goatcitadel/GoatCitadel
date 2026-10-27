import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { channelPageHref } from "../../../app/routes";
import { queryKeys } from "../../../data/query-keys";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { CONNECTIONS_QUERY_KEY, useChannelConnection } from "../use-channel-connections";
import { BotKeyField, keyWorks, OTHER_APP_NOTE } from "./BotKeyField";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { botChangeNote, whatIsInTheWay, type InTheWay } from "./telegram-key-change-model";
import {
  hostChange,
  HOSTS_UNKNOWN,
  TEST_MESSAGE_CHANGE,
  TurnOnStep,
  turnOnStatus,
  type TurnOnWording,
} from "./TurnOnStep";
import { useChannelRequiredHosts } from "./use-channel-picker-groups";
import { useMissingHosts } from "./use-missing-hosts";
import { useTelegramKeyChange, type TelegramKeyChangeState } from "./use-telegram-key-change";
import { TELEGRAM_CATALOG_ID } from "./use-telegram-setup";
import { useTurnOn, type TurnOnState } from "./use-turn-on";

/** The same step as turning a channel on, with the words of changing a key. */
const SAVE_KEY_WORDING: TurnOnWording = {
  button: "Save key",
  working: "Saving…",
  done: "Saved. Telegram uses the new key now.",
  doneLink: "Back to Telegram's page",
};
/** Where Settings has this channel's key, for a change that has to be finished there. */
const SETTINGS_KEY_HREF = "/settings/connections#channels";
/** This page cannot clear a bot's web address, so it says what to do instead of offering a button. */
const WEB_ADDRESS_NOTE =
  "This bot sends its messages to a web address, so GoatCitadel can't read them here. Stop that in the app that set it up, or use a different key.";

const NOTE_FOR: Readonly<Record<InTheWay, string>> = { web_address: WEB_ADDRESS_NOTE, other_reader: OTHER_APP_NOTE };

/** What the page tells a screen reader after each thing happens: the one status line, latest first. */
function statusLine(
  change: TelegramKeyChangeState,
  turnOn: TurnOnState,
  inTheWay: InTheWay | null,
  botChange: string | undefined,
  hostsFailed: boolean,
): string | undefined {
  if (change.error) return change.error;
  if (change.busy) return "Checking your key…";
  const saving = turnOnStatus(turnOn, SAVE_KEY_WORDING);
  if (saving) return saving;
  if (hostsFailed) return HOSTS_UNKNOWN;
  if (!change.bot) return undefined;
  if (inTheWay) return NOTE_FOR[inTheWay];
  return botChange ?? keyWorks(change.bot.username);
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <Callout tone="warning" announce={false}>
      <p>{children}</p>
    </Callout>
  );
}

/** The two steps for a channel that is there: paste the new key and have it checked, then save it. */
function KeyChangeSteps({ connection, workspaceId }: { connection: IntegrationConnection; workspaceId: string }) {
  const { connectionId, config } = connection;
  const queryClient = useQueryClient();
  const change = useTelegramKeyChange(connection);
  const turnOn = useTurnOn(workspaceId, change.draft?.draftId);
  const requiredHosts = useChannelRequiredHosts(TELEGRAM_CATALOG_ID);
  const key = useCredentialInput(`channel:${workspaceId}:telegram:${connectionId}:new-key`, "", undefined, {
    label: "New Telegram bot key",
    // A half-typed key is not work worth a leave review.
    active: false,
  });
  const { discard: discardKey } = key;
  const { bot, draft } = change;
  const inTheWay = bot ? whatIsInTheWay(config, change) : null;
  const ready = bot !== null && inTheWay === null;
  const saved = turnOn.state === "done";
  const botChange = bot && ready ? botChangeNote(config, bot.username) : undefined;
  // Read once there is a step to save, as on the setup page. Saving waits until the read says which hosts it adds.
  const hosts = useMissingHosts(requiredHosts, ready);

  // The key is stored securely once checked, so what was typed is dropped. A key that failed stays, to fix.
  useEffect(() => {
    if (bot) discardKey();
  }, [bot, discardKey]);
  // Nothing typed outlives the page.
  useEffect(() => discardKey, [discardKey]);
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
        changes={[TEST_MESSAGE_CHANGE, ...hosts.missing.map(hostChange)]}
        turnOn={turnOn}
        wording={SAVE_KEY_WORDING}
        onTurnOn={() => {
          if (draft && requiredHosts && hosts.known) {
            const target = { draftId: draft.draftId, catalogId: TELEGRAM_CATALOG_ID };
            void turnOn.turnOn({ ...target, requiredHosts, shownHosts: hosts.missing });
          }
        }}
        doneHref={channelPageHref(connectionId)}
        disabled={!requiredHosts || !hosts.known}
        workspaceId={workspaceId}
        settingsHref={SETTINGS_KEY_HREF}
        retryHostCheck={hosts.failed ? hosts.retry : undefined}
      />
    </div>
  ) : undefined;
  const steps: SetupStepView[] = [
    {
      id: "new-key",
      title: "Paste the new key",
      state: ready ? "done" : "current",
      result: bot ? keyWorks(bot.username) : undefined,
      children: (
        <>
          {bot && inTheWay ? <Warning>{NOTE_FOR[inTheWay]}</Warning> : null}
          {change.error ? (
            <Callout tone="error" announce={false}>
              <p>{change.error}</p>
            </Callout>
          ) : null}
          <BotKeyField
            value={key.value}
            onChange={key.setValue}
            busy={change.busy}
            checking={change.busy}
            onCheck={() => void change.checkKey(key.value)}
          />
        </>
      ),
    },
    {
      id: "save-key",
      title: "Save the new key",
      state: !ready ? "locked" : saved ? "done" : "current",
      result: saved ? saveStep : undefined,
      children: saveStep,
    },
  ];

  return (
    <SetupFrame
      title="Change Telegram's key"
      back={{ href: channelPageHref(connectionId), label: "Back to channel" }}
      workspaceId={workspaceId}
    >
      <SetupSteps steps={steps} status={statusLine(change, turnOn, inTheWay, botChange, hosts.failed)} />
    </SetupFrame>
  );
}

/**
 * Changing a Telegram channel's key from its page in Chat: paste the new key, have it checked, then save it. Saving
 * is the same step as turning a channel on (a test message, then the change, approved in place), with its own words.
 */
export function TelegramKeyChange({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) {
  const { connection, connections } = useChannelConnection(connectionId);
  if (connection?.key === "telegram") return <KeyChangeSteps connection={connection} workspaceId={workspaceId} />;
  return (
    <SetupFrame
      title="Change Telegram's key"
      back={{ href: channelPageHref(connectionId), label: "Back to channel" }}
      workspaceId={workspaceId}
    >
      {connections.isError ? (
        <>
          <Callout announce={false} tone="error">
            <p>Couldn't load this channel.</p>
          </Callout>
          <div>
            <Button onClick={() => void connections.refetch()}>Try again</Button>
          </div>
        </>
      ) : connections.isPending ? (
        <p className="text-sm text-fg-muted">Loading channel…</p>
      ) : (
        <p className="text-base text-fg-secondary">We couldn't find this Telegram channel.</p>
      )}
    </SetupFrame>
  );
}
