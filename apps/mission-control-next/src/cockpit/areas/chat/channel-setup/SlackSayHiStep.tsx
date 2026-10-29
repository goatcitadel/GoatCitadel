import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { CODE_EXPIRED, WAITING_FOR_HI } from "./SayHiStep";
import { SLACK_MANY_CONVERSATIONS, slackSayHiPrompt } from "./slack-setup-model";
import type { SlackSetupState } from "./use-slack-setup";

/**
 * Step 3: say hi to the bot with a one-time code, by sending it in Slack. Nothing here is a live region: the page's
 * status line says "Waiting for your hi…" and what comes after. When the code expires, or could not be saved, the old
 * code is not shown and a new one is a click away; why it could not be saved is the page's own error message. A bot with
 * many conversations may hide the hi behind newer ones: the step says so, and the code can simply be sent again.
 */
export function SlackSayHiStep({
  botName,
  setup,
}: {
  /** The bot as Slack names it, found by the operator under Apps. */
  botName: string;
  setup: Pick<SlackSetupState, "code" | "codeExpired" | "manyConversations" | "busy" | "error" | "newCode">;
}) {
  const { code, codeExpired, manyConversations, busy, error, newCode } = setup;
  if (codeExpired || (!code && error)) {
    return (
      <>
        {codeExpired ? <p>{CODE_EXPIRED}</p> : null}
        <Button disabled={busy} onClick={() => void newCode()}>
          Get a new code
        </Button>
      </>
    );
  }
  if (!code) return null;
  return (
    <>
      <p className="text-sm text-fg-secondary">
        {slackSayHiPrompt(botName)} <span className="font-mono text-fg">{code}</span>
      </p>
      <p className="text-sm text-fg-secondary">{WAITING_FOR_HI}</p>
      {manyConversations ? (
        <Callout tone="info" announce={false}>
          <p>{SLACK_MANY_CONVERSATIONS}</p>
        </Callout>
      ) : null}
    </>
  );
}
