import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { DISCORD_DEVELOPER_PORTAL, DISCORD_INTENT_OFF } from "./discord-setup-model";
import { TokenField } from "./TokenField";

export function PortalLink() {
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

/**
 * Where the token is pasted, and what stands in the way of using the bot once it checks out. The field is masked, kept
 * only in the volatile credential store, and cleared once the token has been checked. A token that works but whose bot
 * cannot read messages yet (Message Content Intent is off) is already stored, so only a new check is left to ask for.
 */
export function BotToken({
  intentOff,
  busy,
  error,
  value,
  onChange,
  checking,
  onCheck,
  onRecheck,
}: {
  /** The last check worked, but the bot cannot read messages until Message Content Intent is switched on. */
  intentOff: boolean;
  busy: boolean;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  checking: boolean;
  onCheck: () => void;
  onRecheck: () => void;
}) {
  return (
    <>
      {error ? (
        <Callout tone="error" announce={false}>
          <p>{error}</p>
        </Callout>
      ) : null}
      {intentOff ? (
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
