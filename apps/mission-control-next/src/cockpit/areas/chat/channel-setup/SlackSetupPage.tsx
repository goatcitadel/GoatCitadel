import { useEffect, useRef, useState } from "react";
import { HOSTS_UNKNOWN, useMissingHosts } from "../../../../features/native-routes/settings/channel-hosts";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { channelAdvancedSetupHref, channelPageHref, channelPickerHref } from "../../../app/routes";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { CODE_EXPIRED, WAITING_FOR_HI } from "./SayHiStep";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { SlackPostingStep } from "./SlackPostingStep";
import { SlackSayHiStep } from "./SlackSayHiStep";
import { slackCreateAppHref } from "./slack-manifest";
import {
  SLACK_CATALOG_ID,
  SLACK_MAKE_APP_TEXT,
  SLACK_TURN_ON_WORDING,
  slackPostingOptions,
  slackPostingValue,
  slackSaidHi,
  slackSenderName,
  slackTokensWork,
  slackTurnOnChanges,
} from "./slack-setup-model";
import { SlackTokensStep } from "./SlackTokensStep";
import { TurnOnStep, turnOnStatus } from "./TurnOnStep";
import { useChannelSetupHosts } from "./use-channel-picker-groups";
import { useSlackSetup, type SlackSetupState } from "./use-slack-setup";
import { useTurnOn, type TurnOnState } from "./use-turn-on";

/** Where each step is done. */
const ON_THIS_PAGE = "On this page";

function MakeApp() {
  return (
    <div className="space-y-2 text-sm text-fg-secondary">
      <p>{SLACK_MAKE_APP_TEXT}</p>
      <a
        href={slackCreateAppHref()}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-accent underline-offset-2 hover:underline"
      >
        Create the Slack app
      </a>
    </div>
  );
}

/**
 * What the page tells a screen reader after each thing happens: the one status line, latest first. Everything it says
 * is also on the page, in the step it belongs to.
 */
function statusLine(
  setup: SlackSetupState,
  checking: boolean,
  turnOn: TurnOnState,
  page: { hostsFailed: boolean },
): string | undefined {
  if (setup.error) return setup.error;
  if (checking) return "Checking your tokens…";
  const turningOn = turnOnStatus(turnOn, SLACK_TURN_ON_WORDING);
  if (turningOn) return turningOn;
  if (page.hostsFailed) return HOSTS_UNKNOWN;
  if (setup.busy) return "Working…";
  if (setup.sender) return slackSaidHi(slackSenderName(setup.sender));
  if (setup.codeExpired) return CODE_EXPIRED;
  if (setup.code) return WAITING_FOR_HI;
  if (setup.workspace && setup.bot) return slackTokensWork(setup.bot.name, setup.workspace.name);
  return undefined;
}

/**
 * Slack's setup: make an app from a ready-made manifest, install it and copy its two tokens, say hi to the bot, choose
 * where it posts, turn it on. Each step checks itself and the next opens when it has. Saying hi makes the person who
 * does it the bot's only allowed sender; turning on finishes the setup in place.
 */
export function SlackSetupPage({
  workspaceId,
  resumeDraftId,
}: {
  workspaceId: string;
  /** The unfinished setup to go on with, when the page was sent to one; else the newest made on this page. */
  resumeDraftId?: string;
}) {
  const setup = useSlackSetup(workspaceId, resumeDraftId);
  const turnOn = useTurnOn(workspaceId, setup.draft?.draftId);
  const [checking, setChecking] = useState(false);
  // Half-typed tokens are not work worth a leave review.
  const botToken = useCredentialInput(`channel:${workspaceId}:slack:bot-token`, "", undefined, {
    label: "Slack bot token",
    active: false,
  });
  const appToken = useCredentialInput(`channel:${workspaceId}:slack:app-token`, "", undefined, {
    label: "Slack app-level token",
    active: false,
  });
  const { discard: discardBotToken } = botToken;
  const { discard: discardAppToken } = appToken;
  const { workspace, bot, busy, draft, sender, posting, channels, newCode, refreshChannels } = setup;
  const tokensWork = workspace !== null && bot !== null;

  // Where it posts needs a channel's name before Turn on can say it; direct messages are named by the person.
  const channel =
    posting?.kind === "channel" ? channels?.find((candidate) => candidate.id === posting.channelId) : null;
  const turnOnReady = sender !== null && posting !== null && channel !== undefined;
  const requiredHosts = useChannelSetupHosts(SLACK_CATALOG_ID, draft);
  const hosts = useMissingHosts(requiredHosts, turnOnReady);
  const turnedOn = turnOn.state === "done";

  const discardTokens = () => {
    discardBotToken();
    discardAppToken();
  };
  // Both tokens are stored securely once they work, so what was typed is dropped. Tokens that failed stay, to fix.
  useEffect(() => {
    if (tokensWork) {
      discardBotToken();
      discardAppToken();
    }
  }, [tokensWork, discardBotToken, discardAppToken]);
  // Nothing typed outlives the page.
  useEffect(
    () => () => {
      discardBotToken();
      discardAppToken();
    },
    [discardBotToken, discardAppToken],
  );

  // Step 3 opens with a code to send. It is asked for once per setup: if saving it fails, the step offers a button
  // instead of trying again on every draw. Someone who said hi on an earlier visit needs no code.
  const codeAsked = useRef(false);
  const saidHiAlready = sender !== null;
  useEffect(() => {
    if (!tokensWork) {
      codeAsked.current = false;
      return;
    }
    if (codeAsked.current || !draft || busy || saidHiAlready) return;
    codeAsked.current = true;
    void newCode();
  }, [tokensWork, draft, busy, saidHiAlready, newCode]);

  // Step 4 reads the bot's channels once when it opens, and again only when the operator asks (Refresh channels),
  // because the list shares Slack's rate budget with looking for the hi.
  const channelsAsked = useRef(false);
  useEffect(() => {
    if (!saidHiAlready) {
      channelsAsked.current = false;
      return;
    }
    if (channelsAsked.current || busy) return;
    channelsAsked.current = true;
    void refreshChannels();
  }, [saidHiAlready, busy, refreshChannels]);

  const checkTokens = async () => {
    setChecking(true);
    try {
      await setup.checkTokens(botToken.value, appToken.value);
    } finally {
      setChecking(false);
    }
  };
  const startOver = async () => {
    discardTokens();
    await setup.startOver();
  };

  const name = sender ? slackSenderName(sender) : "";
  const turnOnStep =
    sender && posting && turnOnReady ? (
      <TurnOnStep
        changes={slackTurnOnChanges({
          senderName: name,
          posting,
          channelName: channel?.name,
          missingHosts: hosts.missing,
        })}
        turnOn={turnOn}
        onTurnOn={() => {
          if (draft && requiredHosts && hosts.known) {
            const target = { draftId: draft.draftId, catalogId: SLACK_CATALOG_ID };
            void turnOn.turnOn({ ...target, requiredHosts, shownHosts: hosts.missing });
          }
        }}
        doneHref={turnedOn && draft ? channelPageHref(draft.draftId) : undefined}
        disabled={!requiredHosts || !hosts.known}
        workspaceId={workspaceId}
        wording={SLACK_TURN_ON_WORDING}
        retryHostCheck={hosts.failed ? hosts.retry : undefined}
      />
    ) : undefined;
  // What was chosen, in the words it was offered in, once there is nothing left to choose.
  const chosen = sender
    ? slackPostingOptions(name, channels).find((option) => option.value === slackPostingValue(posting))
    : undefined;

  const steps: SetupStepView[] = [
    {
      id: "make-app",
      title: "Make your Slack app",
      place: "In Slack",
      state: tokensWork ? "done" : "current",
      children: <MakeApp />,
    },
    {
      id: "tokens",
      title: "Install it and copy two tokens",
      place: "In Slack, then on this page",
      state: tokensWork ? "done" : "current",
      result: tokensWork ? slackTokensWork(bot.name, workspace.name) : undefined,
      children: (
        <SlackTokensStep
          botToken={botToken.value}
          appToken={appToken.value}
          onBotToken={botToken.setValue}
          onAppToken={appToken.setValue}
          busy={busy}
          checking={checking}
          error={setup.error}
          onCheck={() => void checkTokens()}
        />
      ),
    },
    {
      id: "say-hi",
      title: "Say hi to your bot",
      place: "In Slack",
      waitsFor: "Opens when both tokens work.",
      state: !tokensWork ? "locked" : sender ? "done" : "current",
      result: sender ? slackSaidHi(name) : undefined,
      children: bot ? <SlackSayHiStep botName={bot.name} setup={setup} /> : undefined,
    },
    {
      id: "posts",
      title: "Choose where it posts",
      place: ON_THIS_PAGE,
      waitsFor: "Opens when you've said hi to your bot.",
      state: !sender ? "locked" : turnedOn ? "done" : "current",
      result: turnedOn ? chosen?.label : undefined,
      // Where it posts is not changed under a test message that is being sent or waits to be called fine.
      children: (
        <SlackPostingStep setup={setup} disabled={busy || turnOn.state === "working" || turnOn.state === "cleanup"} />
      ),
    },
    {
      id: "turn-on",
      title: "Turn it on",
      place: ON_THIS_PAGE,
      waitsFor: "Opens when you've chosen where it posts.",
      state: !turnOnStep ? "locked" : turnedOn ? "done" : "current",
      result: turnedOn ? turnOnStep : undefined,
      children: turnOnStep,
    },
  ];

  return (
    <SetupFrame
      title="Set up Slack"
      back={{ href: channelPickerHref(), label: "Back to channels" }}
      workspaceId={workspaceId}
    >
      <SetupSteps steps={steps} status={statusLine(setup, checking, turnOn, { hostsFailed: hosts.failed })} />
      {/* The tokens step shows a failure beside its fields while it is open. Once it is done its body is gone, and a
          failure of something else (the code, the channels, where it posts, Start over) would be heard but not seen,
          so it shows here instead. Never both. */}
      {tokensWork && setup.error ? (
        <Callout tone="error" announce={false}>
          <p>{setup.error}</p>
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-subtle pt-4">
        {/* Nothing to start over from once it is on: the setup is finished, and the draft is the channel. */}
        {turnedOn ? null : (
          <Button variant="ghost" disabled={busy || turnOn.state === "working"} onClick={() => void startOver()}>
            Start over
          </Button>
        )}
        {/* Advanced channel setup keeps Slack's other ways: a webhook with no app, or the OAuth sign-in. */}
        <NativeOwnerLink href={channelAdvancedSetupHref(SLACK_CATALOG_ID)} scope={workspaceId} className="text-sm">
          More options in Advanced channel setup
        </NativeOwnerLink>
      </div>
    </SetupFrame>
  );
}
