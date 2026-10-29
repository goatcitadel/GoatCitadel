import { useEffect, useState } from "react";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { channelPickerHref } from "../../../app/routes";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { settingsChannelSetupHref } from "./channel-picker-model";
import {
  DISCORD_CATALOG_ID,
  DISCORD_DEVELOPER_PORTAL,
  DISCORD_INTENT_OFF,
  discordTokenWorks,
} from "./discord-setup-model";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { TokenField } from "./TokenField";
import { useDiscordSetup, type DiscordSetupState } from "./use-discord-setup";

/** Where each step is done. */
const ON_THIS_PAGE = "On this page";

function PortalLink() {
  return (
    <a
      href={DISCORD_DEVELOPER_PORTAL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block text-accent underline-offset-2 hover:underline"
    >
      Open the Developer Portal
    </a>
  );
}

function MakeBot() {
  return (
    <div className="space-y-2 text-sm text-fg-secondary">
      <p>
        Open the Developer Portal and choose New Application. Name it, then open Bot and choose Reset Token. Copy the
        token it shows.
      </p>
      <PortalLink />
    </div>
  );
}

/**
 * Where the token is pasted, and what stands in the way of using the bot once it checks out. The field is masked, kept
 * only in the volatile credential store, and cleared once the token has been checked. A token that works but whose bot
 * cannot read messages yet (Message Content Intent is off) is already stored, so only a new check is left to ask for.
 */
function BotToken({
  setup,
  value,
  onChange,
  checking,
  onCheck,
  onRecheck,
}: {
  setup: DiscordSetupState;
  value: string;
  onChange: (value: string) => void;
  checking: boolean;
  onCheck: () => void;
  onRecheck: () => void;
}) {
  const { check, busy, error } = setup;
  return (
    <>
      {error ? (
        <Callout tone="error" announce={false}>
          <p>{error}</p>
        </Callout>
      ) : null}
      {check && !check.messageContentIntent ? (
        <>
          <Callout tone="warning" announce={false}>
            <p>{DISCORD_INTENT_OFF}</p>
            <div className="mt-2">
              <PortalLink />
            </div>
          </Callout>
          <div>
            <Button
              variant="primary"
              loading={checking}
              loadingLabel="Checking…"
              disabled={busy && !checking}
              onClick={onRecheck}
            >
              Check again
            </Button>
          </div>
        </>
      ) : (
        <TokenField
          label="Bot token"
          value={value}
          onChange={onChange}
          busy={busy}
          button={{ label: "Check token", checking, onCheck }}
        />
      )}
    </>
  );
}

/**
 * What the page tells a screen reader after each thing happens: the one status line. Everything it says is also on
 * the page, in the step it belongs to.
 */
function statusLine(setup: DiscordSetupState, checking: boolean): string | undefined {
  if (setup.error) return setup.error;
  if (checking) return "Checking your token…";
  if (setup.busy) return "Working…";
  const { check } = setup;
  if (!check) return undefined;
  const works = discordTokenWorks(check.bot.name);
  return check.messageContentIntent ? works : `${works} ${DISCORD_INTENT_OFF}`;
}

/**
 * Discord's setup: make a bot, paste its token, invite it, choose where it posts, turn it on. Each step checks itself
 * and the next opens when it has. The token step also waits for Message Content Intent, which GoatCitadel's connection
 * to Discord cannot do without.
 */
export function DiscordSetupPage({
  workspaceId,
  resumeDraftId,
}: {
  workspaceId: string;
  /** The unfinished setup to go on with, when the page was sent to one; else the newest made on this page. */
  resumeDraftId?: string;
}) {
  const setup = useDiscordSetup(workspaceId, resumeDraftId);
  const [checking, setChecking] = useState(false);
  const token = useCredentialInput(`channel:${workspaceId}:discord:bot-token`, "", undefined, {
    label: "Discord bot token",
    // A half-typed token is not work worth a leave review.
    active: false,
  });
  const { discard: discardToken } = token;
  const { check } = setup;
  const ready = check !== null && check.messageContentIntent;

  // The token is stored securely once checked, so what was typed is dropped. A token that failed stays, to fix.
  useEffect(() => {
    if (check) discardToken();
  }, [check, discardToken]);
  // Nothing typed outlives the page.
  useEffect(() => discardToken, [discardToken]);

  const withChecking = async (action: () => Promise<void>) => {
    setChecking(true);
    try {
      await action();
    } finally {
      setChecking(false);
    }
  };
  const startOver = async () => {
    discardToken();
    await setup.startOver();
  };

  const steps: SetupStepView[] = [
    {
      id: "make-bot",
      title: "Make your bot",
      place: "In Discord's Developer Portal",
      state: check ? "done" : "current",
      children: <MakeBot />,
    },
    {
      id: "bot-token",
      title: "Paste your bot's token",
      place: ON_THIS_PAGE,
      state: ready ? "done" : "current",
      result: check ? discordTokenWorks(check.bot.name) : undefined,
      children: (
        <BotToken
          setup={setup}
          value={token.value}
          onChange={token.setValue}
          checking={checking}
          onCheck={() => void withChecking(() => setup.checkToken(token.value))}
          onRecheck={() => void withChecking(() => setup.recheck())}
        />
      ),
    },
    {
      id: "invite",
      title: "Invite your bot to a server",
      place: "In Discord",
      waitsFor: "Opens when your token works and Message Content Intent is on.",
      state: "locked",
    },
    {
      id: "posts",
      title: "Choose where it posts",
      place: ON_THIS_PAGE,
      waitsFor: "Opens when your bot is in a server.",
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
      title="Set up Discord"
      back={{ href: channelPickerHref(), label: "Back to channels" }}
      workspaceId={workspaceId}
    >
      <SetupSteps steps={steps} status={statusLine(setup, checking)} />
      {/* The token step shows a failure beside its field while it is open. Once it is done its body is gone, and a
          failure of something else (Start over) would be heard but not seen, so it shows here instead. Never both. */}
      {ready && setup.error ? (
        <Callout tone="error" announce={false}>
          <p>{setup.error}</p>
        </Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-subtle pt-4">
        <Button variant="ghost" disabled={setup.busy} onClick={() => void startOver()}>
          Start over
        </Button>
        {/* Settings keeps the other ways to connect Discord, such as a webhook with no bot. */}
        <NativeOwnerLink href={settingsChannelSetupHref(DISCORD_CATALOG_ID)} scope={workspaceId} className="text-sm">
          More options in Settings
        </NativeOwnerLink>
      </div>
    </SetupFrame>
  );
}
