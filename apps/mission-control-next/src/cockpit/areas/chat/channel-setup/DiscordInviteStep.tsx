import { Button } from "../../../ui/Button";
import {
  DISCORD_INVITE_TEXT,
  DISCORD_STILL_WAITING,
  DISCORD_WAITING_FOR_SERVER,
  discordInviteHref,
} from "./discord-setup-model";

/**
 * Step 3: add the bot to a server in Discord. The link is Discord's own, built for this bot with only the permissions
 * it needs; the page waits for the bot to show up, so there is nothing to confirm here. When the wait runs out, the
 * link is still there to open again, and Check again waits another round. Nothing here is a live region: the page's
 * status line says the same words.
 */
export function DiscordInviteStep({
  applicationId,
  waiting,
  expired,
  busy,
  onWaitAgain,
}: {
  applicationId: string;
  /** GoatCitadel is asking Discord whether the bot has joined a server. */
  waiting: boolean;
  /** The wait ran out before the bot joined one. */
  expired: boolean;
  busy: boolean;
  onWaitAgain: () => void;
}) {
  return (
    <>
      <p className="text-sm text-fg-secondary">{DISCORD_INVITE_TEXT}</p>
      <a
        href={discordInviteHref(applicationId)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-accent underline-offset-2 hover:underline"
      >
        Invite your bot
      </a>
      {expired ? (
        <div className="space-y-2">
          <p className="text-sm text-fg-secondary">{DISCORD_STILL_WAITING}</p>
          <Button disabled={busy} onClick={onWaitAgain}>
            Check again
          </Button>
        </div>
      ) : waiting ? (
        <p className="text-sm text-fg-secondary">{DISCORD_WAITING_FOR_SERVER}</p>
      ) : null}
    </>
  );
}
