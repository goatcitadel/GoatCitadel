import { useEffect } from "react";
import { useCredentialInput } from "../../../../features/native-routes/settings/credential-input-owner";
import { Callout } from "../../../ui/Callout";
import { BotToken } from "./DiscordTokenStep";
import { SlackTokensStep } from "./SlackTokensStep";
import type { CheckedTokens, TokenInputs } from "./token-change-model";
import { TokenField } from "./TokenField";
import { WHATSAPP_META_APP_STEPS } from "./whatsapp-setup-model";

/** What the field step of a token change is given: where to keep what is typed, and what the last check found. */
export interface TokenFieldsProps {
  workspaceId: string;
  connectionId: string;
  /** What the last check that worked found. */
  checked: CheckedTokens | null;
  /** The check is in flight: the fields are read-only. */
  busy: boolean;
  error?: string;
  onCheck(tokens: TokenInputs): void;
  /** Checks the tokens already stored again, after a change in the channel's own app. */
  onRecheck(): void;
}

/**
 * Discord's token field, with the button and the Message Content Intent notice of its setup page. What is typed lives
 * only in the volatile credential store: it is dropped once the token has been checked, and when the field goes.
 */
export function DiscordTokenFields({
  workspaceId,
  connectionId,
  checked,
  busy,
  error,
  onCheck,
  onRecheck,
}: TokenFieldsProps) {
  // A half-typed token is not work worth a leave review.
  const token = useCredentialInput(`channel:${workspaceId}:discord:${connectionId}:new-token`, "", undefined, {
    label: "New Discord bot token",
    active: false,
  });
  const { discard } = token;
  useEffect(() => {
    if (checked) discard();
  }, [checked, discard]);
  useEffect(() => discard, [discard]);
  return (
    <BotToken
      intentOff={checked?.inTheWay !== undefined}
      busy={busy}
      error={error}
      value={token.value}
      onChange={token.setValue}
      checking={busy}
      onCheck={() => onCheck({ botToken: token.value, appToken: "" })}
      onRecheck={onRecheck}
    />
  );
}

/**
 * Slack's two token fields, with the button and the help of its setup page. What is typed lives only in the volatile
 * credential store: it is dropped once both have been checked, and when the fields go.
 */
export function SlackTokenFields({ workspaceId, connectionId, checked, busy, error, onCheck }: TokenFieldsProps) {
  const botToken = useCredentialInput(`channel:${workspaceId}:slack:${connectionId}:new-bot-token`, "", undefined, {
    label: "New Slack bot token",
    active: false,
  });
  const appToken = useCredentialInput(`channel:${workspaceId}:slack:${connectionId}:new-app-token`, "", undefined, {
    label: "New Slack app-level token",
    active: false,
  });
  const { discard: discardBotToken } = botToken;
  const { discard: discardAppToken } = appToken;
  useEffect(() => {
    if (checked) {
      discardBotToken();
      discardAppToken();
    }
  }, [checked, discardBotToken, discardAppToken]);
  useEffect(
    () => () => {
      discardBotToken();
      discardAppToken();
    },
    [discardBotToken, discardAppToken],
  );
  return (
    <SlackTokensStep
      botToken={botToken.value}
      appToken={appToken.value}
      onBotToken={botToken.setValue}
      onAppToken={appToken.setValue}
      busy={busy}
      checking={busy}
      error={error}
      onCheck={() => onCheck({ botToken: botToken.value, appToken: appToken.value })}
    />
  );
}

/** The two sentences that say where the new token is made, and what it has to match. */
const WHATSAPP_TOKEN_HELP = `${WHATSAPP_META_APP_STEPS[3]} It has to be for the same Meta app and phone number WhatsApp uses now.`;

/**
 * WhatsApp's access token field, with the button of the other token pages. It is the only secret this page asks for:
 * the App secret and the IDs stay with the saved channel. What is typed lives only in the volatile credential store: it
 * is dropped once the token has been checked, and when the field goes. The value arrives as `botToken`, the name
 * `TokenInputs` gives the first of its two fields.
 */
export function WhatsAppTokenFields({ workspaceId, connectionId, checked, busy, error, onCheck }: TokenFieldsProps) {
  // A half-typed token is not work worth a leave review.
  const token = useCredentialInput(`channel:${workspaceId}:whatsapp:${connectionId}:new-access-token`, "", undefined, {
    label: "New WhatsApp access token",
    active: false,
  });
  const { discard } = token;
  useEffect(() => {
    if (checked) discard();
  }, [checked, discard]);
  useEffect(() => discard, [discard]);
  return (
    <>
      <p className="text-sm text-fg-secondary">{WHATSAPP_TOKEN_HELP}</p>
      {error ? (
        <Callout tone="error" announce={false}>
          <p>{error}</p>
        </Callout>
      ) : null}
      <TokenField
        label="Access token"
        value={token.value}
        onChange={token.setValue}
        busy={busy}
        button={{
          label: "Check token",
          checking: busy,
          onCheck: () => onCheck({ botToken: token.value, appToken: "" }),
        }}
      />
    </>
  );
}
