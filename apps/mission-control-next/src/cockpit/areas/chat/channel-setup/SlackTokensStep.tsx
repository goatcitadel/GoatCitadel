import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { SLACK_TOKEN_STEPS } from "./slack-setup-model";
import { TokenField } from "./TokenField";

/**
 * Where the two tokens are found and pasted. Both fields are masked and held by the caller in the volatile credential
 * store; one button checks both. A failure shows beside the fields, in the one sentence the hook gives, and what was
 * typed stays to be fixed.
 */
export function SlackTokensStep({
  botToken,
  appToken,
  onBotToken,
  onAppToken,
  busy,
  checking,
  error,
  onCheck,
}: {
  botToken: string;
  appToken: string;
  onBotToken: (value: string) => void;
  onAppToken: (value: string) => void;
  /** Something is in flight: the fields are read-only and only the check that is running keeps its button. */
  busy: boolean;
  /** The check itself is in flight. */
  checking: boolean;
  error?: string;
  onCheck: () => void;
}) {
  const both = botToken.trim() !== "" && appToken.trim() !== "";
  return (
    <>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-secondary">
        {SLACK_TOKEN_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {error ? (
        <Callout tone="error" announce={false}>
          <p>{error}</p>
        </Callout>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (both && !busy) onCheck();
        }}
      >
        <TokenField label="Bot token" value={botToken} onChange={onBotToken} busy={busy} />
        <TokenField label="App-level token" value={appToken} onChange={onAppToken} busy={busy} />
        <Button
          type="submit"
          variant="primary"
          loading={checking}
          loadingLabel="Checking…"
          disabled={!both || (busy && !checking)}
        >
          Check tokens
        </Button>
      </form>
    </>
  );
}
