import { useEffect, useState } from "react";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { channelPickerHref } from "../../../app/routes";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { settingsChannelSetupHref } from "./channel-picker-model";
import { QrCode } from "./QrCode";
import { SetupFrame } from "./SetupFrame";
import { SetupSteps, type SetupStepView } from "./SetupSteps";
import { TELEGRAM_CATALOG_ID, useTelegramSetup, type TelegramSetupState } from "./use-telegram-setup";

const BOTFATHER_URL = "https://t.me/BotFather";
const WEB_ADDRESS_NOTE =
  "This bot sends its messages to a web address, so GoatCitadel can't read them here. If another app uses that address, it stops getting messages.";
const OTHER_APP_NOTE = "Another app is reading this bot's messages. Stop it there, or make a new bot for GoatCitadel.";

function MakeBot() {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <QrCode value={BOTFATHER_URL} label="QR code that opens BotFather" />
      <div className="min-w-48 flex-1 space-y-2 text-sm text-fg-secondary">
        <p>Scan this with your phone to open BotFather in Telegram. Send /newbot and pick a name.</p>
        <a
          href={BOTFATHER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-accent underline-offset-2 hover:underline"
        >
          Open BotFather
        </a>
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
}: {
  setup: TelegramSetupState;
  value: string;
  onChange: (value: string) => void;
  checking: boolean;
  onCheck: () => void;
}) {
  const { bot, busy, conflict, error, webhookActive } = setup;
  return (
    <>
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
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onCheck();
        }}
      >
        <Field label="Bot key">
          {(field) => (
            <input
              {...field}
              type="password"
              // Browsers ignore "off" on a password field, and offer to save it when this form goes away.
              autoComplete="new-password"
              autoCapitalize="off"
              spellCheck={false}
              className={cockpitInputClass}
              value={value}
              readOnly={busy}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          loading={checking}
          loadingLabel="Checking…"
          disabled={!value.trim() || (busy && !checking)}
        >
          Check key
        </Button>
      </form>
    </>
  );
}

const keyWorks = (username: string) => `Key works. Your bot is @${username}.`;

/** What the page tells a screen reader after each thing the operator does. */
function statusLine(setup: TelegramSetupState, checking: boolean): string | undefined {
  if (setup.error) return setup.error;
  if (checking) return "Checking your key…";
  if (setup.busy) return "Working…";
  return setup.bot ? keyWorks(setup.bot.username) : undefined;
}

/**
 * Telegram's setup: make a bot, paste its key, say hi, turn it on. Each step checks itself and the next opens when it
 * has. The first two are here; the last two stay locked until their content arrives.
 */
export function TelegramSetupPage({ workspaceId }: { workspaceId: string }) {
  const setup = useTelegramSetup(workspaceId);
  const [checking, setChecking] = useState(false);
  const key = useCredentialInput(`channel:${workspaceId}:telegram:bot-key`, "", undefined, {
    label: "Telegram bot key",
    // A half-typed key is not work worth a leave review.
    active: false,
  });
  const { discard: discardKey } = key;
  const { bot, conflict, webhookActive } = setup;

  // The key is stored securely once checked, so what was typed is dropped. A key that failed stays, to fix.
  useEffect(() => {
    if (bot) discardKey();
  }, [bot, discardKey]);
  // Nothing typed outlives the page.
  useEffect(() => discardKey, [discardKey]);

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

  const ready = bot !== null && !webhookActive && !conflict;
  const steps: SetupStepView[] = [
    { id: "make-bot", title: "Make your bot", state: bot ? "done" : "current", children: <MakeBot /> },
    {
      id: "bot-key",
      title: "Paste the key BotFather sent you",
      state: ready ? "done" : "current",
      result: bot ? keyWorks(bot.username) : undefined,
      children: (
        <BotKey
          setup={setup}
          value={key.value}
          onChange={key.setValue}
          checking={checking}
          onCheck={() => void check()}
        />
      ),
    },
    { id: "say-hi", title: "Say hi to your bot", state: ready ? "current" : "locked" },
    { id: "turn-on", title: "Turn it on", state: "locked" },
  ];

  return (
    <SetupFrame
      title="Set up Telegram"
      back={{ href: channelPickerHref(), label: "Back to channels" }}
      workspaceId={workspaceId}
    >
      <SetupSteps steps={steps} status={statusLine(setup, checking)} />
      {/* The key step shows a failure beside its field while it is open. Once it is done its body is gone, and a
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
        <NativeOwnerLink href={settingsChannelSetupHref(TELEGRAM_CATALOG_ID)} scope={workspaceId} className="text-sm">
          More options in Settings
        </NativeOwnerLink>
      </div>
    </SetupFrame>
  );
}
