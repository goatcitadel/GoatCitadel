import { useEffect, useState } from "react";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { channelPickerHref } from "../../../app/routes";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { settingsChannelSetupHref } from "./channel-picker-model";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { slackCreateAppHref } from "./slack-manifest";
import { SLACK_CATALOG_ID, SLACK_MAKE_APP_TEXT, slackTokensWork } from "./slack-setup-model";
import { SlackTokensStep } from "./SlackTokensStep";
import { useSlackSetup, type SlackSetupState } from "./use-slack-setup";

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
function statusLine(setup: SlackSetupState, checking: boolean): string | undefined {
  if (setup.error) return setup.error;
  if (checking) return "Checking your tokens…";
  if (setup.busy) return "Working…";
  if (setup.workspace && setup.bot) return slackTokensWork(setup.bot.name, setup.workspace.name);
  return undefined;
}

/**
 * Slack's setup: make an app from a ready-made manifest, install it and copy its two tokens, say hi to the bot, choose
 * where it posts, turn it on. Each step checks itself and the next opens when it has. This page checks the tokens;
 * the steps after them open once the rest of the setup is built.
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
  const { workspace, bot, busy } = setup;
  const tokensWork = workspace !== null && bot !== null;

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
      state: "locked",
    },
    {
      id: "posts",
      title: "Choose where it posts",
      place: ON_THIS_PAGE,
      waitsFor: "Opens when you've said hi to your bot.",
      state: "locked",
    },
    {
      id: "turn-on",
      title: "Turn it on",
      place: ON_THIS_PAGE,
      waitsFor: "Opens when you've chosen where it posts.",
      state: "locked",
    },
  ];

  return (
    <SetupFrame
      title="Set up Slack"
      back={{ href: channelPickerHref(), label: "Back to channels" }}
      workspaceId={workspaceId}
    >
      <SetupSteps steps={steps} status={statusLine(setup, checking)} />
      {/* The tokens step shows a failure beside its fields while it is open. Once it is done its body is gone, and a
          failure of something else (Start over) would be heard but not seen, so it shows here instead. Never both. */}
      {tokensWork && setup.error ? (
        <Callout tone="error" announce={false}>
          <p>{setup.error}</p>
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-subtle pt-4">
        <Button variant="ghost" disabled={busy} onClick={() => void startOver()}>
          Start over
        </Button>
        {/* Settings keeps the other ways to connect Slack, such as a webhook with no app or the OAuth sign-in. */}
        <NativeOwnerLink href={settingsChannelSetupHref(SLACK_CATALOG_ID)} scope={workspaceId} className="text-sm">
          More options in Settings
        </NativeOwnerLink>
      </div>
    </SetupFrame>
  );
}
