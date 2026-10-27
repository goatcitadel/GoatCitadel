import { useEffect, useRef, useState } from "react";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { channelPickerHref } from "../../../app/routes";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { BotKeyField, keyWorks, OTHER_APP_NOTE, WEB_ADDRESS_NOTE } from "./BotKeyField";
import { senderName } from "./code-sender";
import { QrCode } from "./QrCode";
import { CODE_EXPIRED, SayHiStep, WAITING_FOR_HI } from "./SayHiStep";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { HOSTS_UNKNOWN, TurnOnStep, turnOnChanges, turnOnStatus } from "./TurnOnStep";
import { useChannelRequiredHosts } from "./use-channel-picker-groups";
import { useMissingHosts } from "./use-missing-hosts";
import { useConnectedTelegramBot, useNewTelegramHref } from "./use-new-connection-href";
import { TELEGRAM_CATALOG_ID, useTelegramSetup, type TelegramSetupState } from "./use-telegram-setup";
import { useTurnOn, type TurnOnState } from "./use-turn-on";

const BOTFATHER_URL = "https://t.me/BotFather";

/** BotFather asks these in turn; the last answer is the key step 2 takes. */
const BOTFATHER_STEPS = [
  "Send /newbot.",
  "Send a name for your bot. Any name works.",
  'Send a username for it. It has to end in "bot", like goat_helper_bot.',
  "BotFather replies with your bot's key, a long line like 123456789:AAH… Copy it.",
] as const;

function MakeBot() {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <QrCode value={BOTFATHER_URL} label="QR code that opens BotFather" />
      <div className="min-w-48 flex-1 space-y-2 text-sm text-fg-secondary">
        <p>
          Scan this code with your phone to open BotFather, Telegram&apos;s bot for making bots, or open it on this
          computer.
        </p>
        <a
          href={BOTFATHER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-accent underline-offset-2 hover:underline"
        >
          Open BotFather
        </a>
        <ol className="list-decimal space-y-1 pl-5">
          {BOTFATHER_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * Where the key is pasted, and what stands in the way of using the bot once it checks out. The field is masked, kept
 * only in the volatile credential store, and cleared once the key has been checked.
 */
function BotKey({
  setup,
  value,
  onChange,
  checking,
  onCheck,
  connectedHref,
  workspaceId,
}: {
  setup: TelegramSetupState;
  value: string;
  onChange: (value: string) => void;
  checking: boolean;
  onCheck: () => void;
  /** The page of the channel this bot already is, when it is one. */
  connectedHref?: string;
  workspaceId: string;
}) {
  const { bot, busy, conflict, error, webhookActive } = setup;
  return (
    <>
      {bot && connectedHref ? (
        <Callout tone="warning" announce={false}>
          <p>{ALREADY_CONNECTED}</p>
          <div className="mt-2">
            <NativeOwnerLink href={connectedHref} scope={workspaceId}>
              Open its page
            </NativeOwnerLink>
          </div>
        </Callout>
      ) : null}
      {bot && webhookActive ? (
        <Callout tone="warning" announce={false}>
          <p>{WEB_ADDRESS_NOTE}</p>
          <div className="mt-2">
            <Button size="sm" disabled={busy} onClick={() => void setup.stopWebAddress()}>
              Stop sending to that address
            </Button>
          </div>
        </Callout>
      ) : null}
      {bot && conflict ? (
        <Callout tone="warning" announce={false}>
          <p>{OTHER_APP_NOTE}</p>
        </Callout>
      ) : null}
      {error ? (
        <Callout tone="error" announce={false}>
          <p>{error}</p>
        </Callout>
      ) : null}
      <p className="text-sm text-fg-secondary">
        Paste the key from BotFather&apos;s reply. It&apos;s not your bot&apos;s name or username.
      </p>
      <BotKeyField value={value} onChange={onChange} busy={busy} checking={checking} onCheck={onCheck} />
    </>
  );
}

const saidHi = (name: string) => `${name} said hi. Only they can message your bot for now.`;
/** Where each step is done. */
const IN_TELEGRAM = "In Telegram";
const ON_THIS_PAGE = "On this page";
/** Settings' channel list, where a Telegram channel that is on gets its groups, formatting and voice replies. */
const SETTINGS_CHANNELS_HREF = "/settings/connections#channels";
/** A second channel for one bot would fight the first for its messages, so the setup stops at the key. */
const ALREADY_CONNECTED = "This bot is already connected to GoatCitadel.";

/**
 * What the page tells a screen reader after each thing happens: the one status line, latest first. Everything it says
 * is also on the page, in the step it belongs to.
 */
function statusLine(
  setup: TelegramSetupState,
  checking: boolean,
  turnOn: TurnOnState,
  page: { hostsFailed: boolean; alreadyConnected: boolean },
): string | undefined {
  if (setup.error) return setup.error;
  if (checking) return "Checking your key…";
  const turningOn = turnOnStatus(turnOn);
  if (turningOn) return turningOn;
  if (page.hostsFailed) return HOSTS_UNKNOWN;
  if (setup.busy) return "Working…";
  if (page.alreadyConnected) return ALREADY_CONNECTED;
  if (setup.sender) return saidHi(senderName(setup.sender));
  if (setup.codeExpired) return CODE_EXPIRED;
  if (setup.code) return WAITING_FOR_HI;
  return setup.bot ? keyWorks(setup.bot.username) : undefined;
}

/**
 * Telegram's setup: make a bot, paste its key, say hi, turn it on. Each step checks itself and the next opens when it
 * has. Saying hi makes the person who does it the bot's only allowed sender; turning on finishes the setup in place.
 */
export function TelegramSetupPage({
  workspaceId,
  resumeDraftId,
}: {
  workspaceId: string;
  /** The unfinished setup to go on with, when the page was sent to one; else the newest. */
  resumeDraftId?: string;
}) {
  const setup = useTelegramSetup(workspaceId, resumeDraftId);
  const turnOn = useTurnOn(workspaceId, setup.draft?.draftId);
  const requiredHosts = useChannelRequiredHosts(TELEGRAM_CATALOG_ID);
  const [checking, setChecking] = useState(false);
  const key = useCredentialInput(`channel:${workspaceId}:telegram:bot-key`, "", undefined, {
    label: "Telegram bot key",
    // A half-typed key is not work worth a leave review.
    active: false,
  });
  const { discard: discardKey } = key;
  const { bot, conflict, draft, sender, webhookActive } = setup;
  // A bot that is already a channel goes no further than its key.
  const connected = useConnectedTelegramBot(bot?.username);
  const ready = bot !== null && !webhookActive && !conflict && connected.state === "none";
  const hosts = useMissingHosts(requiredHosts, ready && sender !== null);
  const doneHref = useNewTelegramHref(turnOn.state === "done", bot?.username);

  // The key is stored securely once checked, so what was typed is dropped. A key that failed stays, to fix.
  useEffect(() => {
    if (bot) discardKey();
  }, [bot, discardKey]);
  // Nothing typed outlives the page.
  useEffect(() => discardKey, [discardKey]);

  // Step 3 opens with a code to send. It is asked for once per setup: if saving it fails, the step offers a button
  // instead of trying again on every draw. Someone who said hi on an earlier visit needs no code.
  const codeAsked = useRef(false);
  const { busy, newCode } = setup;
  const saidHiAlready = sender !== null;
  useEffect(() => {
    if (!ready) {
      codeAsked.current = false;
      return;
    }
    if (codeAsked.current || !draft || busy || saidHiAlready) return;
    codeAsked.current = true;
    void newCode();
  }, [ready, draft, busy, saidHiAlready, newCode]);

  const check = async () => {
    setChecking(true);
    try {
      await setup.checkKey(key.value);
    } finally {
      setChecking(false);
    }
  };
  const startOver = async () => {
    discardKey();
    await setup.startOver();
  };

  const name = sender ? senderName(sender) : "";
  const turnOnStep =
    sender && bot ? (
      <TurnOnStep
        changes={turnOnChanges({ senderName: name, botUsername: bot.username, missingHosts: hosts.missing })}
        turnOn={turnOn}
        onTurnOn={() => {
          if (draft && requiredHosts && hosts.known) {
            const target = { draftId: draft.draftId, catalogId: TELEGRAM_CATALOG_ID };
            void turnOn.turnOn({ ...target, requiredHosts, shownHosts: hosts.missing });
          }
        }}
        doneHref={doneHref}
        disabled={!requiredHosts || !hosts.known}
        workspaceId={workspaceId}
        retryHostCheck={hosts.failed ? hosts.retry : undefined}
      />
    ) : undefined;
  const turnedOn = turnOn.state === "done";
  const steps: SetupStepView[] = [
    {
      id: "make-bot",
      title: "Make your bot",
      place: IN_TELEGRAM,
      state: bot ? "done" : "current",
      children: <MakeBot />,
    },
    {
      id: "bot-key",
      title: "Paste your bot's key",
      place: ON_THIS_PAGE,
      state: ready ? "done" : "current",
      result: bot ? keyWorks(bot.username) : undefined,
      children: (
        <BotKey
          setup={setup}
          value={key.value}
          onChange={key.setValue}
          checking={checking}
          onCheck={() => void check()}
          connectedHref={connected.state === "connected" ? connected.href : undefined}
          workspaceId={workspaceId}
        />
      ),
    },
    {
      id: "say-hi",
      title: "Say hi to your bot",
      place: IN_TELEGRAM,
      waitsFor: "Opens when your key works.",
      state: !ready ? "locked" : sender ? "done" : "current",
      result: sender ? saidHi(name) : undefined,
      children: bot ? <SayHiStep username={bot.username} setup={setup} /> : undefined,
    },
    {
      id: "turn-on",
      title: "Turn it on",
      place: ON_THIS_PAGE,
      waitsFor: "Opens when your hi arrives.",
      state: !ready || !sender ? "locked" : turnedOn ? "done" : "current",
      result: turnedOn ? turnOnStep : undefined,
      children: turnOnStep,
    },
  ];

  return (
    <SetupFrame
      title="Set up Telegram"
      back={{ href: channelPickerHref(), label: "Back to channels" }}
      workspaceId={workspaceId}
    >
      <SetupSteps
        steps={steps}
        status={statusLine(setup, checking, turnOn, {
          hostsFailed: hosts.failed,
          alreadyConnected: connected.state === "connected",
        })}
      />
      {/* The key step shows a failure beside its field while it is open. Once it is done its body is gone, and a
          failure of something else (Start over) would be heard but not seen, so it shows here instead. Never both. */}
      {ready && setup.error ? (
        <Callout tone="error" announce={false}>
          <p>{setup.error}</p>
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-subtle pt-4">
        {/* Nothing to start over from once the channel is on: the setup is finished, and what is left is Settings'.
            Before then Settings has nothing for this setup: it sends a new Telegram setup here. */}
        {turnedOn ? (
          <NativeOwnerLink href={SETTINGS_CHANNELS_HREF} scope={workspaceId} className="text-sm">
            Add groups, formatting or voice replies in Settings
          </NativeOwnerLink>
        ) : (
          <Button variant="ghost" disabled={setup.busy || turnOn.state === "working"} onClick={() => void startOver()}>
            Start over
          </Button>
        )}
      </div>
    </SetupFrame>
  );
}
