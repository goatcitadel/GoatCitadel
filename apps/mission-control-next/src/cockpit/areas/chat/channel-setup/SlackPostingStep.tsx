import { Button } from "../../../ui/Button";
import { PostingChoice } from "./PostingChoice";
import {
  SLACK_POSTING_LEGEND,
  slackInviteHelp,
  slackPostingFromValue,
  slackPostingOptions,
  slackPostingValue,
  slackSenderName,
} from "./slack-setup-model";
import type { SlackSetupState } from "./use-slack-setup";

/**
 * Step 4: where the bot posts. It starts on direct messages with the person who said hi, chosen for you; each channel
 * the bot is in is another choice, answering the same person when they mention it. A bot is in a channel only once
 * the operator has added it in Slack, so the step says how, and Refresh channels reads the list again. Every choice
 * is saved as soon as it is made. People and channels are named, never numbered. Nothing here is a live region.
 */
export function SlackPostingStep({ setup, disabled }: { setup: SlackSetupState; disabled: boolean }) {
  const { sender, bot, channels, posting } = setup;
  if (!sender || !bot) return null;
  return (
    <>
      <PostingChoice
        legend={SLACK_POSTING_LEGEND}
        options={slackPostingOptions(slackSenderName(sender), channels)}
        value={slackPostingValue(posting)}
        onChange={(value) => {
          const next = slackPostingFromValue(value);
          if (next) void setup.choosePosting(next);
        }}
        disabled={disabled}
      />
      <p className="text-sm text-fg-secondary">{slackInviteHelp(bot.name)}</p>
      <div>
        <Button size="sm" disabled={disabled} onClick={() => void setup.refreshChannels()}>
          Refresh channels
        </Button>
      </div>
    </>
  );
}
